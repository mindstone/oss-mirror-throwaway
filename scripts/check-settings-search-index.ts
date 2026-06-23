#!/usr/bin/env npx tsx
/**
 * CI Validation: Settings Search Index ↔ Component Sync
 *
 * Bidirectional check ensuring the static search index stays in sync with
 * `data-section` attributes in settings components:
 *
 *   Forward: every `data-section` in components has ≥1 matching search entry
 *            (or is explicitly allowlisted as intentionally unindexed)
 *   Reverse: every `section` in the search index references a `data-section`
 *            that actually exists in components
 *
 * Run:  npx tsx scripts/check-settings-search-index.ts
 * Wired into: npm run validate:fast (via validate:settings-search)
 *
 * @see docs/plans/260402_settings_search_index_sync.md
 * @see docs/project/UI_SETTINGS_AND_FORMS.md — "Search Index Sync" section for design rationale
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Allowlist — composite anchors & sub-sections intentionally unindexed
// ---------------------------------------------------------------------------

/**
 * Sections that intentionally have no search index entry.
 * Each entry has a comment explaining why.
 */
const INTENTIONALLY_UNINDEXED = new Set([
  // Composite on-page nav anchors (children are individually indexed)
  'supportDiagnostics',
  'developerTools',
  'labsPlugins',
  // Sub-sections of indexed parents
  'apiKey',
  'otherProviders',
  // Informational note row under the indexed 'backupConnections' section (260618 Stage 6)
  'backupConnectionsProfileNote',
  // Disclosure wrapper around modelTeam (which is itself indexed)
  'modelTeamDisclosure',
  // Dynamic scroll-target selector in BackupConnectionsSection — `${connectSection}`
  // resolves at runtime to an already-indexed connect section (codex/openrouter/apiKey/
  // providerKeys); it's a nav reference, not a new anchor.
  '${connectSection}',
]);

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Extract all `data-section="value"` attribute values from JSX source text.
 * Returns an array of unique section identifiers.
 */
export function extractDataSections(source: string): string[] {
  const pattern = /data-section="([^"]+)"/g;
  const sections = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    sections.add(match[1]);
  }
  return [...sections];
}

/**
 * Extract unique `section` values from the search index source text.
 * Parses `section: 'value'` entries from the TypeScript array.
 */
export function loadSearchIndexSections(indexSource: string): string[] {
  const pattern = /section:\s*'([^']+)'/g;
  const sections = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(indexSource)) !== null) {
    sections.add(match[1]);
  }
  return [...sections];
}

/**
 * Cross-reference component sections against index sections.
 *
 * @returns missingFromIndex — component sections not in index and not allowlisted
 * @returns staleInIndex    — index sections not found in any component
 */
export function crossReference(
  componentSections: Set<string>,
  indexSections: Set<string>,
  allowlist: Set<string>,
): { missingFromIndex: string[]; staleInIndex: string[] } {
  const missingFromIndex: string[] = [];
  for (const section of componentSections) {
    if (!indexSections.has(section) && !allowlist.has(section)) {
      missingFromIndex.push(section);
    }
  }

  const staleInIndex: string[] = [];
  for (const section of indexSections) {
    if (!componentSections.has(section)) {
      staleInIndex.push(section);
    }
  }

  return {
    missingFromIndex: missingFromIndex.sort(),
    staleInIndex: staleInIndex.sort(),
  };
}

// ---------------------------------------------------------------------------
// File scanning helpers
// ---------------------------------------------------------------------------

interface SectionLocation {
  section: string;
  file: string;
}

function walkTsxFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.tsx')) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

function scanComponentSections(componentsDir: string, rootDir: string): SectionLocation[] {
  const results: SectionLocation[] = [];
  const files = walkTsxFiles(componentsDir);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const sections = extractDataSections(content);
    const relativePath = path.relative(rootDir, filePath);
    for (const section of sections) {
      results.push({ section, file: relativePath });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI main — only runs when executed directly
// ---------------------------------------------------------------------------

function main(): void {
  const ROOT_DIR = path.join(__dirname, '..');
  const COMPONENTS_DIR = path.join(ROOT_DIR, 'src', 'renderer', 'features', 'settings', 'components');
  const INDEX_PATH = path.join(ROOT_DIR, 'src', 'renderer', 'features', 'settings', 'searchIndex.ts');

  console.log('Checking settings search index ↔ component sync...\n');

  // 1. Scan component files for data-section attributes
  const componentLocations = scanComponentSections(COMPONENTS_DIR, ROOT_DIR);
  const componentSections = new Set(componentLocations.map((loc) => loc.section));

  // 2. Parse search index for section values
  const indexSource = fs.readFileSync(INDEX_PATH, 'utf8');
  const indexSectionsList = loadSearchIndexSections(indexSource);
  const indexSections = new Set(indexSectionsList);

  // 3. Cross-reference
  const { missingFromIndex, staleInIndex } = crossReference(
    componentSections,
    indexSections,
    INTENTIONALLY_UNINDEXED,
  );

  // 4. Report
  console.log(`Component data-sections: ${componentSections.size}`);
  console.log(`Search index sections:   ${indexSections.size}`);
  console.log(`Allowlisted (skipped):   ${INTENTIONALLY_UNINDEXED.size}`);

  const hasErrors = missingFromIndex.length > 0 || staleInIndex.length > 0;

  if (hasErrors) {
    console.error('\nERROR: Settings search index drift detected!\n');

    if (missingFromIndex.length > 0) {
      console.error('Missing from search index (add entries to SETTINGS_SEARCH_INDEX in searchIndex.ts):');
      for (const section of missingFromIndex) {
        const locations = componentLocations.filter((loc) => loc.section === section);
        const fileList = locations.map((loc) => loc.file).join(', ');
        console.error(`  - data-section="${section}" found in ${fileList}`);
        console.error(`    → Add: { tab: '<tab>', section: '${section}', label: '...', keywords: [...] }`);
        console.error(`    → Or add '${section}' to INTENTIONALLY_UNINDEXED if this is a composite anchor\n`);
      }
    }

    if (staleInIndex.length > 0) {
      console.error('Stale search index entries (section no longer exists in components):');
      for (const section of staleInIndex) {
        console.error(`  - section: '${section}' in search index has no matching data-section in components`);
      }
    }

    console.error(`\nFAILED: ${missingFromIndex.length} missing + ${staleInIndex.length} stale = ${missingFromIndex.length + staleInIndex.length} issue(s).`);
    console.error('Fix: Update SETTINGS_SEARCH_INDEX in src/renderer/features/settings/searchIndex.ts');
    process.exit(1);
  } else {
    console.log('\nPASSED: Settings search index is in sync with component data-sections.');
  }
}

// Run CLI when executed directly (not when imported for tests)
const isDirectExecution = require.main === module;
if (isDirectExecution) {
  main();
}
