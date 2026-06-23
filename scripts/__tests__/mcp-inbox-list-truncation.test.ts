/**
 * MCP rebel_inbox_list default cap + summary truncation (C16, Sprint 2 Stage F).
 *
 * Verifies that:
 * 1. The handler defaults `limit` to LIST_DEFAULT_LIMIT (50) when omitted.
 * 2. Summaries in the list view are truncated at LIST_SUMMARY_MAX_CHARS (500).
 * 3. The tool description and schema reflect both behaviours.
 *
 * Run: npx vitest run scripts/__tests__/mcp-inbox-list-truncation.test.ts
 *
 * @see resources/mcp/rebel-inbox/server.cjs
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER_PATH = join(
  __dirname,
  '..',
  '..',
  'resources',
  'mcp',
  'rebel-inbox',
  'server.cjs'
);
const source = readFileSync(SERVER_PATH, 'utf8');

describe('rebel_inbox_list default cap + summary truncation (C16)', () => {
  it('declares LIST_DEFAULT_LIMIT = 50 and LIST_SUMMARY_MAX_CHARS = 500', () => {
    expect(source).toMatch(/const\s+LIST_DEFAULT_LIMIT\s*=\s*50\b/);
    expect(source).toMatch(/const\s+LIST_SUMMARY_MAX_CHARS\s*=\s*500\b/);
  });

  it('applies LIST_DEFAULT_LIMIT in the list handler when limit is omitted', () => {
    expect(source).toMatch(
      /const\s+effectiveLimit\s*=\s*limit\s*\?\?\s*LIST_DEFAULT_LIMIT/
    );
    expect(source).toMatch(/limit:\s*effectiveLimit/);
  });

  it('truncates summary text in formatItemList with the documented suffix', () => {
    expect(source).toMatch(
      /rawText\.length\s*>\s*LIST_SUMMARY_MAX_CHARS/
    );
    expect(source).toMatch(
      /rawText\.slice\(\s*0\s*,\s*LIST_SUMMARY_MAX_CHARS\s*\)/
    );
    expect(source).toContain(
      '…[truncated, use rebel_inbox_get for full text]'
    );
  });

  it('tool description and schema mention the new default cap', () => {
    expect(source).toMatch(/first \$\{LIST_DEFAULT_LIMIT\} active items/);
    expect(source).toMatch(/Default:\s*\$\{LIST_DEFAULT_LIMIT\}/);
    expect(source).toMatch(/default:\s*\$\{LIST_DEFAULT_LIMIT\}/);
  });

  it('tool description mentions the summary truncation budget', () => {
    expect(source).toMatch(
      /capped at \$\{LIST_SUMMARY_MAX_CHARS\} characters/
    );
  });
});

describe('rebel_inbox_list truncation behaviour (logic check)', () => {
  // Recreate the truncation predicate from server.cjs so we exercise the same
  // boundary semantics (≤ MAX = unchanged, > MAX = truncated + suffix).
  const LIST_SUMMARY_MAX_CHARS = 500;
  const truncate = (rawText: string): string =>
    rawText.length > LIST_SUMMARY_MAX_CHARS
      ? `${rawText.slice(0, LIST_SUMMARY_MAX_CHARS)}…[truncated, use rebel_inbox_get for full text]`
      : rawText;

  it('passes through text at or below the limit unchanged', () => {
    const short = 'a'.repeat(LIST_SUMMARY_MAX_CHARS);
    expect(truncate(short)).toBe(short);
  });

  it('truncates and appends the suffix when over the limit', () => {
    const long = 'a'.repeat(LIST_SUMMARY_MAX_CHARS + 200);
    const out = truncate(long);
    expect(out.startsWith('a'.repeat(LIST_SUMMARY_MAX_CHARS))).toBe(true);
    expect(out.endsWith('…[truncated, use rebel_inbox_get for full text]')).toBe(true);
  });
});
