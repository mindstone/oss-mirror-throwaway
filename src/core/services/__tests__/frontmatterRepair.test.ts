/**
 * Tests for `frontmatterRepair.ts` (Stage 3 refinement pass).
 *
 * Scope:
 *   - S3-F1 safety gate: `validateRepairSafety` runs the fidelity check
 *     AND the body-plausibility heuristic. Both must reject the concrete
 *     regression scenarios flagged in Stage 3 review before a candidate
 *     mechanical repair is accepted for on-disk write. The orchestrator
 *     `tryMechanicalFrontmatterRepair` is covered indirectly via
 *     `spaceMaintenanceService.test.ts` and `spaceService.test.ts`; the
 *     concrete duplicate-key + body-rule regression is asserted here.
 *   - S3-F2 atomic-write preservation: when any step of the tmp + fsync
 *     + rename sequence fails, the file on disk must remain at the
 *     ORIGINAL bytes (never a half-written or truncated state).
 *   - S3-F6 post-rename rollback: when the post-rename re-parse fails,
 *     the original bytes are restored via `fs.writeFile(filePath, originalBytes)`.
 *
 * @see docs/plans/260411_shared_space_maintenance.md (Stage 3 Refinement)
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  atomicWriteWithReValidate,
  FRONTMATTER_REPAIR_TMP_SUFFIX,
  looksLikeMarkdownBody,
  tryMechanicalFrontmatterRepair,
  validateRepairSafety,
  type AtomicWriteFs,
} from '../frontmatterRepair';

describe('validateRepairSafety — S3-F1 safety gate', () => {
  it('rejects when the candidate drops a key the original had (fidelity-check-failed)', () => {
    const original = [
      '---',
      'foo: one',
      'bar: two',
      '---',
      '# body',
    ].join('\n');
    const candidate = [
      '---',
      'foo: one',
      '---',
      '# body',
    ].join('\n');

    const safety = validateRepairSafety(original, candidate, ['duplicate-keys']);
    expect(safety.ok).toBe(false);
    if (safety.ok) throw new Error('unreachable');
    expect(safety.reason).toBe('fidelity-check-failed');
    expect(safety.detail).toContain('bar');
  });

  it('rejects when the candidate renames a key (not a superset)', () => {
    const original = '---\nfoo: one\nbar: two\n---\n# body\n';
    // `bar` renamed to `baz` — originalKeys = {foo, bar}, fixedKeys = {foo, baz}.
    const candidate = '---\nfoo: one\nbaz: two\n---\n# body\n';

    const safety = validateRepairSafety(original, candidate, ['duplicate-keys']);
    expect(safety.ok).toBe(false);
    if (safety.ok) throw new Error('unreachable');
    expect(safety.reason).toBe('fidelity-check-failed');
  });

  it('S3-F1 body-plausibility: rejects a missing-close candidate containing a markdown heading', () => {
    // The reviewer's concrete scenario — the candidate frontmatter region
    // sweeps up a `## Heading` line from the body. The heuristic must
    // flag this even though the YAML itself parses.
    const original = '---\ntitle: foo\n## Body heading\nMore body prose.\n';
    const candidate = '---\ntitle: foo\n## Body heading\n---\nMore body prose.\n';

    const safety = validateRepairSafety(original, candidate, ['missing-closing-delimiter']);
    expect(safety.ok).toBe(false);
    if (safety.ok) throw new Error('unreachable');
    expect(safety.reason).toBe('body-absorption-detected');
    expect(safety.detail).toContain('markdown body');
  });

  it('does NOT run the body-plausibility check when only dedupe/indent fixes were applied', () => {
    // Same candidate as above (markdown heading inside "frontmatter") —
    // but without `missing-closing-delimiter` in the applied-fixes list,
    // the heuristic is skipped. Fidelity may still pass because neither
    // side parses cleanly and the regex fallback only enforces superset-
    // of-keys. This documents the heuristic's narrow scope.
    const original = '---\ntitle: foo\n## Body heading\n---\nbody\n';
    const candidate = '---\ntitle: foo\n## Body heading\n---\nbody\n';

    const safety = validateRepairSafety(original, candidate, ['duplicate-keys']);
    expect(safety.ok).toBe(true);
  });

  it('accepts a legitimate repair whose frontmatter contains no body patterns', () => {
    const original = '---\ntitle: foo\ntags: [a, b]\n---\n# body\n';
    const candidate = '---\ntitle: foo\ntags:\n  - a\n  - b\n---\n# body\n';

    const safety = validateRepairSafety(original, candidate, [
      'duplicate-keys',
      'indentation-normalize',
    ]);
    expect(safety.ok).toBe(true);
  });
});

describe('tryMechanicalFrontmatterRepair — body-absorption regression', () => {
  it('S3-F1 regression: duplicate-key YAML + body `---` rule must not silently absorb body', async () => {
    // Concrete scenario from the Stage 3 review:
    //   - Opening `---` on line 0.
    //   - User forgot the real closing `---` (or the file was edited to
    //     remove it) — the `splitFrontmatter` heuristic now picks the
    //     body's markdown horizontal rule as the "close".
    //   - The frontmatter has duplicate `title:` keys that may trip
    //     stricter YAML parsers.
    //   - The body contains a markdown heading below the rule that MUST
    //     remain body content.
    //
    // Acceptance: `repaired === false`, and `newContent` is byte-equal
    // to the original input (the caller uses `newContent` as the file-
    // to-write; a poisoned candidate here would silently corrupt the
    // README on disk).
    const broken = [
      '---',
      'title: My Skill',
      'title: Duplicate Key',
      '',
      'Introduction text that is intentionally long enough to trip the prose heuristic.',
      '',
      '---',
      '',
      '## Section 2 heading',
      '',
      'Body content after the horizontal rule.',
    ].join('\n');

    const originalBytes = Buffer.from(broken, 'utf8');

    const result = tryMechanicalFrontmatterRepair(broken);

    // Whether the repair succeeded or was rejected, the invariant the
    // safety gate enforces is: if a mechanical fix is accepted, the
    // result must not silently discard body bytes. The two legitimate
    // outcomes are:
    //   (a) `repaired: true` AND the body tail is preserved byte-exact, OR
    //   (b) `repaired: false` AND `newContent === broken` (no mutation).
    if (result.repaired) {
      // If accepted, the body bytes after the final `---` must still
      // contain the original heading + prose. Body-absorption would
      // cause these to disappear.
      expect(result.newContent).toContain('## Section 2 heading');
      expect(result.newContent).toContain('Body content after the horizontal rule.');
    } else {
      // Rejected path: content must match original byte-for-byte.
      expect(Buffer.from(result.newContent, 'utf8')).toEqual(originalBytes);
      expect(result.appliedFixes).toEqual([]);
    }
  });

  it('accepts a legitimate duplicate-key dedupe that does not touch body', () => {
    const broken = [
      '---',
      'title: earlier draft',
      'sharing: team',
      'title: final kept',
      '---',
      '',
      '# Body heading',
      '',
      'Prose paragraph.',
    ].join('\n');

    const result = tryMechanicalFrontmatterRepair(broken);

    expect(result.repaired).toBe(true);
    expect(result.appliedFixes).toContain('duplicate-keys');
    // Body preserved.
    expect(result.newContent).toContain('# Body heading');
    expect(result.newContent).toContain('Prose paragraph.');
    expect(result.rejectionReason).toBeUndefined();
  });
});

describe('looksLikeMarkdownBody', () => {
  it('flags ATX headings', () => {
    expect(looksLikeMarkdownBody('## Section 2')).toBe(true);
    expect(looksLikeMarkdownBody('#### Subheading')).toBe(true);
  });

  it('flags asterisk bullets', () => {
    expect(looksLikeMarkdownBody('* bullet item')).toBe(true);
  });

  it('flags long prose ending in sentence punctuation', () => {
    expect(
      looksLikeMarkdownBody(
        'This is a long line of prose intended to describe something complex.',
      ),
    ).toBe(true);
  });

  it('does NOT flag typical YAML keys', () => {
    expect(looksLikeMarkdownBody('title: My Skill')).toBe(false);
    expect(looksLikeMarkdownBody('sharing: team')).toBe(false);
    expect(looksLikeMarkdownBody('tags:\n  - one\n  - two')).toBe(false);
  });

  it('does NOT flag short value strings with punctuation', () => {
    expect(looksLikeMarkdownBody('description: short.')).toBe(false);
  });
});

describe('atomicWriteWithReValidate — S3-F2 + S3-F6', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-write-'));
  });

  afterEach(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('writes the new content and returns true on the happy path', async () => {
    const target = path.join(tmpDir, 'README.md');
    const original = '---\nbroken: {unclosed\n---\n# body\n';
    const repaired = '---\nbroken: unclosed\n---\n# body\n';
    await fs.writeFile(target, original);

    const ok = await atomicWriteWithReValidate(target, Buffer.from(original), repaired);

    expect(ok).toBe(true);
    const after = await fs.readFile(target, 'utf8');
    expect(after).toBe(repaired);
    // Tmp cleaned up by the rename.
    await expect(fs.access(`${target}${FRONTMATTER_REPAIR_TMP_SUFFIX}`)).rejects.toThrow();
  });

  it('S3-F2: preserves original bytes when rename fails mid-flight', async () => {
    const target = path.join(tmpDir, 'README.md');
    const originalText = '---\nkept: original\n---\n# body\n';
    const candidateText = '---\nkept: repaired\n---\n# body\n';
    await fs.writeFile(target, originalText);
    const originalBytes = await fs.readFile(target);

    const errors: string[] = [];
    const fsStub: AtomicWriteFs = {
      open: fs.open,
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      rename: vi.fn(async () => {
        throw new Error('simulated crash during rename');
      }) as unknown as AtomicWriteFs['rename'],
      unlink: fs.unlink,
    };

    const ok = await atomicWriteWithReValidate(target, originalBytes, candidateText, {
      fs: fsStub,
      onError: (msg) => errors.push(msg),
    });

    expect(ok).toBe(false);
    expect(errors.some((e) => /rename failed/.test(e))).toBe(true);
    // Original file on disk is untouched — this is the atomicity invariant.
    const after = await fs.readFile(target, 'utf8');
    expect(after).toBe(originalText);
    // Tmp has been cleaned up (not left lying around for the next run).
    await expect(fs.access(`${target}${FRONTMATTER_REPAIR_TMP_SUFFIX}`)).rejects.toThrow();
  });

  it('S3-F6: rolls back to original bytes when the post-rename re-parse fails', async () => {
    const target = path.join(tmpDir, 'README.md');
    const originalText = '---\nfoo: original-value\n---\n# original body\n';
    const poisonedText = '---\nfoo: poisoned\n---\n# poisoned body\n';
    await fs.writeFile(target, originalText);
    const originalBytes = await fs.readFile(target);

    const errors: string[] = [];
    // The helper calls readFile twice: once on the TMP path (for
    // hash-verify), once on the TARGET path (after rename, for re-parse).
    // We corrupt ONLY the post-rename read — short-circuiting the first
    // would prevent the test from reaching the rollback branch at all.
    const readFileStub = vi.fn(async (p: unknown) => {
      const asString = typeof p === 'string' ? p : String(p);
      if (asString.endsWith(FRONTMATTER_REPAIR_TMP_SUFFIX)) {
        return await fs.readFile(asString);
      }
      // First (and only) post-rename read: return bytes that
      // `fm()` will throw on. `{` without its matching `}` is
      // the standard "unterminated flow mapping" YAML error.
      return Buffer.from('---\nfoo: {unterminated flow\n---\n');
    });
    const fsStub: AtomicWriteFs = {
      open: fs.open,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: fs.unlink,
      readFile: readFileStub as unknown as AtomicWriteFs['readFile'],
    };

    const ok = await atomicWriteWithReValidate(target, originalBytes, poisonedText, {
      fs: fsStub,
      onError: (msg) => errors.push(msg),
    });

    expect(ok).toBe(false);
    // The rollback error message MUST surface — the code path both wrote
    // the original bytes back AND reported the failure to `onError`.
    expect(errors.some((e) => /post-write re-validate failed/.test(e))).toBe(true);
    // On-disk state: the rollback wrote the ORIGINAL bytes back. The
    // intermediate poisoned state is not observable after the function
    // returns.
    const after = await fs.readFile(target);
    expect(after).toEqual(originalBytes);
  });

  it('returns false and preserves original when tmp write itself fails', async () => {
    const target = path.join(tmpDir, 'README.md');
    const originalText = '---\nfoo: bar\n---\n# body\n';
    await fs.writeFile(target, originalText);
    const originalBytes = await fs.readFile(target);

    const errors: string[] = [];
    const fsStub: AtomicWriteFs = {
      open: vi.fn(async () => {
        throw new Error('simulated disk full');
      }) as unknown as AtomicWriteFs['open'],
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      rename: fs.rename,
      unlink: fs.unlink,
    };

    const ok = await atomicWriteWithReValidate(target, originalBytes, 'new content', {
      fs: fsStub,
      onError: (msg) => errors.push(msg),
    });

    expect(ok).toBe(false);
    expect(errors.some((e) => /tmp write failed/.test(e))).toBe(true);
    const after = await fs.readFile(target, 'utf8');
    expect(after).toBe(originalText);
  });
});
