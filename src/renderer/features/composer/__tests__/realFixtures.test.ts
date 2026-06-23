// @vitest-environment happy-dom
/**
 * Real-fixture round-trip tests (Stage 2 — uses the 10 synthesised fixtures
 * from Stage 0). Uses happy-dom because `markdownToDoc` may construct PM nodes
 * via `editor.schema.nodeFromJSON` indirectly through some assertions; happy-dom
 * is the project-wide standard for composer tests.
 *
 * Each fixture under
 * `src/renderer/features/composer/utils/__tests__/fixtures/realMessages/`
 * declares an `input` (the raw draft markdown, possibly corrupted with
 * NBSP-family entities) and an `expectedSanitised` (the canonical wire-format
 * shape after passing through `markdownToDoc → docToMarkdown`).
 *
 * The test loops over all 10 fixtures and asserts:
 *
 *   docToMarkdown(markdownToDoc(fixture.input)) === fixture.expectedSanitised
 *
 * This is the Risk #13 mitigation the original 260429 plan called for —
 * round-trip tests against fixtures that mirror real-world drafts. Per user
 * decision (2026-05-01) the fixtures are **synthesised** rather than extracted
 * from real session stores (PII concerns); see the planning doc's "Test
 * fixture synthesis" section.
 *
 * Environment is `node` — pure-string round-trips, no DOM required.
 *
 * See `docs/plans/260501_composer_tiptap_atmention_bugfix.md`.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { docToMarkdown, markdownToDoc } from '../utils/promptDoc';

interface ComposerFixture {
  name: string;
  description: string;
  input: string;
  expectedSanitised: string;
  /** Optional notes about the post-sanitised doc shape; not asserted directly. */
  expectedDocShape?: string;
}

const FIXTURE_DIR = path.join(
  __dirname,
  '..',
  'utils',
  '__tests__',
  'fixtures',
  'realMessages',
);

function loadFixtures(): ComposerFixture[] {
  const files = fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort();
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
    const parsed = JSON.parse(raw) as ComposerFixture;
    return parsed;
  });
}

describe('Real-fixture round-trip — 10 synthesised composer drafts', () => {
  const fixtures = loadFixtures();

  it('discovers exactly the 10 expected fixture files', () => {
    expect(fixtures).toHaveLength(10);
  });

  it.each(fixtures)(
    'fixture $name: docToMarkdown(markdownToDoc(input)) === expectedSanitised',
    (fixture) => {
      const restored = docToMarkdown(markdownToDoc(fixture.input));
      expect(restored).toBe(fixture.expectedSanitised);
      // Sanitised output never contains NBSP-family entities — locked invariant.
      expect(restored).not.toContain('&nbsp;');
      expect(restored).not.toContain('\u00a0');
      expect(restored).not.toContain('&NBSP;');
      expect(restored).not.toContain('&#160;');
      expect(restored).not.toContain('&#xA0;');
    },
  );

  it.each(fixtures)('fixture $name: round-trip is idempotent (second pass is a no-op)', (fixture) => {
    const firstPass = docToMarkdown(markdownToDoc(fixture.input));
    const secondPass = docToMarkdown(markdownToDoc(firstPass));
    expect(secondPass).toBe(firstPass);
  });
});
