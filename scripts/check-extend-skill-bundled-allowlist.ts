#!/usr/bin/env npx tsx
/**
 * Validates the bundled-* rebel-oss allowlist in
 * rebel-system/skills/coding/extend-mcp-server/SKILL.md stays in sync with
 * resources/connector-catalog.json.
 *
 * The SKILL uses this allowlist as a deterministic fallback for classifying
 * Path A vs Path B when the catalog tool (rebel_mcp_get_connector) is
 * unavailable (e.g., in the planner phase, which has no MCP tools). If the
 * allowlist drifts from the catalog, the planner can produce wrong
 * classifications that short-circuit the whole turn via direct_answer.
 *
 * Two invariants are checked:
 *
 *   1. Exact set equality:
 *        { ids in allowlist }
 *        ==
 *        { id in catalog | id.startsWith('bundled-') && provider === 'rebel-oss' }
 *
 *   2. bundled-* universe partition safety:
 *        every id in catalog that starts with 'bundled-' has provider in
 *        { 'rebel-oss', 'bundled' }. If a future entry lands with a different
 *        provider, the SKILL's "everything else starting with bundled-" prose
 *        would silently misclassify — so fail loudly instead.
 *
 * See docs-private/postmortems/260423_gamma_provider_misclassification_postmortem.md
 * for the bug class this guards.
 *
 * Run via: npx tsx scripts/check-extend-skill-bundled-allowlist.ts
 * Part of validate:fast pipeline.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const skillPath = join(
  repoRoot,
  'rebel-system',
  'skills',
  'coding',
  'extend-mcp-server',
  'SKILL.md',
);
const catalogPath = join(repoRoot, 'resources', 'connector-catalog.json');

const ALLOWLIST_START = '<!-- BUNDLED_REBEL_OSS_ALLOWLIST_START -->';
const ALLOWLIST_END = '<!-- BUNDLED_REBEL_OSS_ALLOWLIST_END -->';
const STAGE5_PENDING_REBEL_OSS_IDS = new Set<string>();

interface CatalogEntry {
  id: string;
  provider?: string;
}

interface Catalog {
  connectors: CatalogEntry[];
}

function extractAllowlistIds(skillText: string): string[] {
  const startIdx = skillText.indexOf(ALLOWLIST_START);
  const endIdx = skillText.indexOf(ALLOWLIST_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Could not find allowlist block markers in SKILL.md. Expected ${ALLOWLIST_START} … ${ALLOWLIST_END}`,
    );
  }
  const block = skillText.slice(startIdx + ALLOWLIST_START.length, endIdx);

  // Parse YAML-style bullet list: lines like "  - bundled-gamma"
  const ids: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const id = line.slice(2).trim();
    if (!id) continue;
    // Reject quoting/suffixes to keep the block machine-clean
    if (id.includes('"') || id.includes("'") || id.includes(' ')) {
      throw new Error(
        `Allowlist entry has unexpected characters: ${JSON.stringify(id)}. Use bare ids, one per line.`,
      );
    }
    ids.push(id);
  }

  if (ids.length === 0) {
    throw new Error('Allowlist block is empty — did the format change?');
  }

  return ids;
}

function main(): void {
  console.log('📜 extend-mcp-server SKILL.md bundled-* allowlist check');
  console.log('========================================================\n');

  const skillText = readFileSync(skillPath, 'utf8');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;

  const allowlistIds = extractAllowlistIds(skillText);
  const allowlistSet = new Set(allowlistIds);

  // Check for duplicates and sort-order drift (keeps the block scannable)
  const sorted = [...allowlistIds].sort();
  const duplicates = allowlistIds.filter(
    (id, i, arr) => arr.indexOf(id) !== i,
  );
  if (duplicates.length > 0) {
    console.error(`❌ Duplicate ids in allowlist: ${duplicates.join(', ')}\n`);
    process.exit(1);
  }
  if (allowlistIds.join('\n') !== sorted.join('\n')) {
    console.error('❌ Allowlist entries are not sorted alphabetically.\n');
    console.error('   Expected order:');
    for (const id of sorted) console.error(`     - ${id}`);
    console.error('');
    process.exit(1);
  }

  // Derive truth from the catalog
  const catalogRebelOssBundled: string[] = [];
  const catalogBundledPrefixOther: Array<{ id: string; provider: string }> = [];
  for (const entry of catalog.connectors) {
    if (!entry.id.startsWith('bundled-')) continue;
    const provider = entry.provider ?? '<missing>';
    if (provider === 'rebel-oss') {
      catalogRebelOssBundled.push(entry.id);
    } else if (provider !== 'bundled') {
      catalogBundledPrefixOther.push({ id: entry.id, provider });
    }
  }
  const catalogRebelOssSet = new Set([
    ...catalogRebelOssBundled,
    ...STAGE5_PENDING_REBEL_OSS_IDS,
  ]);

  let hasError = false;

  // Invariant 1 — exact set equality
  const missingFromSkill = catalogRebelOssBundled.filter(
    (id) => !allowlistSet.has(id),
  );
  const extraInSkill = allowlistIds.filter((id) => !catalogRebelOssSet.has(id));

  if (missingFromSkill.length > 0) {
    console.error(
      `❌ ${missingFromSkill.length} bundled-* rebel-oss id(s) in catalog but missing from SKILL allowlist:\n`,
    );
    for (const id of missingFromSkill) console.error(`   - ${id}`);
    console.error('');
    hasError = true;
  }

  if (extraInSkill.length > 0) {
    console.error(
      `❌ ${extraInSkill.length} id(s) in SKILL allowlist but not rebel-oss bundled-* in catalog:\n`,
    );
    for (const id of extraInSkill) {
      const entry = catalog.connectors.find((c) => c.id === id);
      const provider = entry?.provider ?? '<not in catalog>';
      console.error(`   - ${id}  (catalog says provider=${provider})`);
    }
    console.error('');
    hasError = true;
  }

  // Invariant 2 — bundled-* partition safety
  if (catalogBundledPrefixOther.length > 0) {
    console.error(
      `❌ ${catalogBundledPrefixOther.length} catalog entry/entries start with 'bundled-' but have a provider other than 'rebel-oss' or 'bundled':\n`,
    );
    for (const { id, provider } of catalogBundledPrefixOther) {
      console.error(`   - ${id}  provider=${provider}`);
    }
    console.error(
      "\n   The SKILL's Path A/B fallback assumes every bundled-* id is either rebel-oss (Path A)\n" +
        '   or bundled (Path B). A third provider value means the "everything else starting with\n' +
        '   bundled-" prose in SKILL.md would silently misclassify these entries.\n' +
        '   Fix: either change the id prefix, update the catalog entry, or update the SKILL to\n' +
        '   distinguish the new provider class.\n',
    );
    hasError = true;
  }

  if (hasError) {
    process.exit(1);
  }

  console.log(
    `✅ ${allowlistIds.length} rebel-oss bundled-* ids in SKILL allowlist match catalog\n` +
      `✅ All bundled-* catalog entries partition cleanly into rebel-oss | bundled\n`,
  );
}

main();
