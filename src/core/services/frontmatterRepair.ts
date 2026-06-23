/**
 * Frontmatter Repair (Stage 3)
 *
 * Pure-function helpers for the shared-space maintenance pipeline's
 * frontmatter repair step. Two repair layers sit on top of these helpers:
 *
 *   1. `scanSpaces` writable auto-fix (`src/main/services/spaceService.ts`)
 *      runs the mechanical pass so that the UI's own space listing path
 *      can heal damaged-but-present YAML without a daily-maintenance wait.
 *   2. `repairBrokenFrontmatter` in `spaceMaintenanceService.ts` invokes
 *      the same mechanical pass first, then falls back to an LLM repair
 *      of the frontmatter-only text when the mechanical layer comes up
 *      short. Body preservation is byte-exact — the LLM never sees the
 *      body and never re-emits it.
 *
 * Architectural invariants:
 *   - No Electron imports. Safe to use from both `src/main/` and the
 *     scheduled daily pipeline in `src/core/`.
 *   - Repair orchestration (`tryMechanicalFrontmatterRepair`,
 *     `compareFrontmatterFidelity`, `splitFrontmatter`, etc.) is
 *     pure-function: no I/O, testable from unit tests with string
 *     inputs alone.
 *   - `atomicWriteWithReValidate` is the lone I/O helper. It's scoped
 *     to this module so every caller that writes a frontmatter repair
 *     (spaceService's scan-side auto-fix + the daily maintenance
 *     pipeline) funnels through the same tmp + fsync + rename + parse-
 *     check sequence. `fs` is accepted as an injected dep so tests can
 *     drive failure modes (post-rename parse failure, rename crash, etc.)
 *     without temp directories.
 *   - The underlying YAML parser is `front-matter` (already used by
 *     `spaceService.ts`). We wrap fragments in synthetic delimiters so
 *     every repair path parses through the same engine the rest of the
 *     codebase uses.
 *
 * @see docs/plans/260411_shared_space_maintenance.md (Stage 3)
 */
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs/promises';
import fm from 'front-matter';

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/**
 * Result of `splitFrontmatter`. `frontmatterText` is decoded as UTF-8 text;
 * `bodyBytes` is the raw byte tail after the closing `---` delimiter —
 * preserved verbatim so reassembly is byte-exact.
 */
export interface FrontmatterSplit {
  /** True iff the first non-BOM line of the file is `---` (possibly with trailing whitespace). */
  hasOpenDelimiter: boolean;
  /** True iff a matching closing `---\s*$` line was found. */
  hasClosingDelimiter: boolean;
  /**
   * UTF-8 text between the opening and (optional) closing delimiters.
   * When `hasClosingDelimiter` is false, this is everything from the first
   * line after `---` through to end-of-file.
   */
  frontmatterText: string;
  /**
   * Raw bytes that follow the closing `---` line (and its trailing
   * newline). Empty Buffer when there is no closing delimiter or no body.
   * The caller MUST reassemble with these bytes verbatim — the LLM repair
   * path does NOT send the body through the model.
   */
  bodyBytes: Buffer;
  /** Detected line ending from the opening `---` line. Default `\n`. */
  lineEnding: '\n' | '\r\n';
  /**
   * Byte offset at which the opening `---` line starts. Usually 0; non-zero
   * iff the file had a leading BOM. Preserved so callers can reattach it.
   */
  openDelimiterByteOffset: number;
  /** Raw bytes of any leading BOM (or empty Buffer if none). */
  leadingBomBytes: Buffer;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Attempt to split a file's bytes into `{ frontmatter, body }` for repair.
 *
 * Returns `null` when the file does NOT start with a `---` line — Stage 3
 * repair is for damaged-but-present frontmatter only. Files without any
 * frontmatter are handled upstream by `spaceService.addDescriptionToFrontmatter`.
 *
 * The split is byte-exact for the body side: everything AFTER the closing
 * `---\n` is captured as raw bytes so the reassembly round-trip can't
 * introduce encoding drift.
 */
export function splitFrontmatter(bytes: Buffer): FrontmatterSplit | null {
  let cursor = 0;
  let leadingBomBytes = Buffer.alloc(0);
  if (bytes.length >= 3 && bytes.slice(0, 3).equals(UTF8_BOM)) {
    leadingBomBytes = bytes.slice(0, 3);
    cursor = 3;
  }

  // Find the end of the first line.
  const firstLineEnd = findNextLineEnd(bytes, cursor);
  if (firstLineEnd === -1) return null;

  const firstLineText = bytes.slice(cursor, firstLineEnd.lineEndByte).toString('utf8');
  if (!isDelimiterLine(firstLineText)) return null;

  const lineEnding: '\n' | '\r\n' = firstLineEnd.lineEnding;
  const openDelimiterByteOffset = cursor;
  // Body text begins at the byte AFTER the opening `---` line's line ending.
  let scanCursor = firstLineEnd.nextByte;

  // Find a closing `---` line.
  let closeLineStart = -1;
  let closeNextByte = -1;

  while (scanCursor < bytes.length) {
    const lineEnd = findNextLineEnd(bytes, scanCursor);
    const endByte = lineEnd === -1 ? bytes.length : lineEnd.lineEndByte;
    const nextByte = lineEnd === -1 ? bytes.length : lineEnd.nextByte;
    const lineText = bytes.slice(scanCursor, endByte).toString('utf8');
    if (isDelimiterLine(lineText)) {
      closeLineStart = scanCursor;
      closeNextByte = nextByte;
      break;
    }
    if (lineEnd === -1) break;
    scanCursor = nextByte;
  }

  const hasClosingDelimiter = closeLineStart !== -1;
  let frontmatterText: string;
  let bodyBytes: Buffer;

  if (hasClosingDelimiter) {
    frontmatterText = bytes.slice(firstLineEnd.nextByte, closeLineStart).toString('utf8');
    bodyBytes = bytes.slice(closeNextByte);
  } else {
    frontmatterText = bytes.slice(firstLineEnd.nextByte).toString('utf8');
    bodyBytes = Buffer.alloc(0);
  }

  return {
    hasOpenDelimiter: true,
    hasClosingDelimiter,
    frontmatterText,
    bodyBytes,
    lineEnding,
    openDelimiterByteOffset,
    leadingBomBytes,
  };
}

/**
 * Reassemble a file from a (possibly-repaired) frontmatter text + the
 * byte-exact body tail captured in `split`. The line ending used for the
 * rebuilt `---` delimiters matches whatever the original file used.
 */
export function reassembleFile(
  split: FrontmatterSplit,
  newFrontmatterText: string,
): Buffer {
  const eol = split.lineEnding;
  // Trim any trailing newline characters the repair left behind — we'll
  // add exactly one via the delimiter. Do NOT trim leading indentation or
  // interior newlines; those belong to the YAML author.
  const trimmed = newFrontmatterText.replace(/\r?\n+$/, '');
  const header = Buffer.concat([split.leadingBomBytes, Buffer.from(`---${eol}`, 'utf8')]);
  const bodyFrontmatter = Buffer.from(`${trimmed}${eol}---${eol}`, 'utf8');
  return Buffer.concat([header, bodyFrontmatter, split.bodyBytes]);
}

// ---------------------------------------------------------------------------
// Mechanical repairs
// ---------------------------------------------------------------------------

export type MechanicalRepairFix =
  | 'missing-closing-delimiter'
  | 'duplicate-keys'
  | 'indentation-normalize';

export type MechanicalRepairRejection =
  /**
   * The repaired frontmatter parses but drops or mutates keys that the
   * original text contained — we'd silently lose metadata. Callers MUST
   * treat this as "do not write" and leave the file for the LLM fallback
   * (or the user).
   */
  | 'fidelity-check-failed'
  /**
   * The missing-closing-delimiter repair placed the close so far down the
   * file that the resulting "frontmatter" region contains markdown body
   * patterns — headings, bullet lists, prose paragraphs. This is almost
   * certainly body-absorption: the original file had no close delimiter
   * AND a body-level `---` horizontal rule, so `splitFrontmatter` (or the
   * candidate insertion) swept body content into the YAML region.
   */
  | 'body-absorption-detected';

export interface MechanicalRepairOutput {
  /**
   * True iff at least one fix was applied AND the resulting frontmatter
   * parses AND the post-repair safety checks (fidelity + body-plausibility)
   * accept the output. `false` means the input was already parseable,
   * none of the attempted fixes produced a parseable result, OR the
   * safety checks rejected the candidate.
   */
  repaired: boolean;
  /**
   * Content after each repair attempt. Always returned (even when
   * `repaired: false`) so callers can inspect intermediate state. When the
   * input is unmodified (or the repair was rejected by a safety check),
   * this equals the input.
   */
  newContent: string;
  /** Which fixes actually changed the content and are present in `newContent`. */
  appliedFixes: MechanicalRepairFix[];
  /** True iff the final `newContent` parses as YAML through the shared parser. */
  parses: boolean;
  /** If `parses` is `false`, the error message from the last parse attempt. */
  parseError?: string;
  /**
   * Populated when a candidate repair produced parseable YAML but a
   * post-repair safety check rejected it. `newContent` will be the
   * ORIGINAL content in that case (we never write a rejected candidate).
   * Callers can log this for diagnostic surfaces; typical operational
   * response is to escalate the file to the LLM fallback.
   */
  rejectionReason?: MechanicalRepairRejection;
  /** Human-readable detail about `rejectionReason` (never machine-parsed). */
  rejectionDetail?: string;
}

/**
 * Top-level orchestrator. Attempts each mechanical repair in turn; each
 * fix is only retained if it contributes to a successful parse (or makes
 * forward progress that lets a subsequent fix succeed).
 *
 * Ordering rationale:
 *   1. Missing closing delimiter first — without the close, subsequent
 *      YAML-level repairs (dedupe, indent) have no scope to operate on.
 *   2. Duplicate keys — cheap, unambiguous when detected via regex scan.
 *   3. Indentation normalisation — purely tab->space, last resort.
 *
 * The function returns the input unchanged when the input already parses.
 *
 * Safety envelope (S3-F1): any candidate that reaches the final
 * "repaired" gate runs through TWO guards before being accepted:
 *
 *   - **Fidelity check** — `compareFrontmatterFidelity` on the ORIGINAL
 *     frontmatter text vs the NEW frontmatter text. Rejects repairs that
 *     drop keys, rename keys, or mutate values beyond the date/whitespace
 *     normalisations the comparator tolerates. Defends against the case
 *     where the original `splitFrontmatter` boundary was wrong (e.g. body
 *     was absorbed) AND the mechanical fixes silently discarded content
 *     while "cleaning up" the YAML.
 *
 *   - **Body-plausibility heuristic** — when the repair added a missing
 *     close delimiter, the new frontmatter region is scanned for markdown
 *     body patterns (ATX headings, asterisk bullets, long prose lines). A
 *     hit means the inserted close landed below real body content — we
 *     refuse the repair rather than emit a file where headings render as
 *     YAML comments.
 *
 * When a guard rejects, `newContent` is reset to the original input, the
 * applied-fixes list is cleared, and `rejectionReason`/`rejectionDetail`
 * carry the machine-stable reason. Callers MUST NOT write rejected
 * candidates to disk — `attemptMechanicalFrontmatterRepairOnDisk` and
 * `repairBrokenFrontmatter` both honour this by keying off `repaired`.
 */
export function tryMechanicalFrontmatterRepair(content: string): MechanicalRepairOutput {
  const initialSplit = splitFrontmatter(Buffer.from(content, 'utf8'));
  if (!initialSplit || !initialSplit.hasOpenDelimiter) {
    // No opening `---` — out of scope for Stage 3 repair. Files without
    // any frontmatter are handled by `spaceService.addDescriptionToFrontmatter`.
    return {
      repaired: false,
      newContent: content,
      appliedFixes: [],
      parses: false,
      parseError: 'no opening frontmatter delimiter',
    };
  }

  // Fast path: has both delimiters AND parses? No-op.
  if (initialSplit.hasClosingDelimiter && parseFullDocument(content).ok) {
    return {
      repaired: false,
      newContent: content,
      appliedFixes: [],
      parses: true,
    };
  }

  let working = content;
  const applied: MechanicalRepairFix[] = [];

  // (1) Missing closing delimiter — operates on the whole file.
  if (!initialSplit.hasClosingDelimiter) {
    const withClose = tryAddMissingClosingDelimiter(working);
    if (withClose && withClose !== working) {
      working = withClose;
      applied.push('missing-closing-delimiter');
    }
  }

  // If we still don't have a close, the YAML-level fixes have no scope.
  const postCloseSplit = splitFrontmatter(Buffer.from(working, 'utf8'));
  if (!postCloseSplit || !postCloseSplit.hasClosingDelimiter) {
    const parse = parseFullDocument(working);
    return finaliseRepair(content, working, applied, {
      candidateRepaired: parse.ok && applied.length > 0,
      parses: parse.ok,
      parseError: parse.ok ? undefined : parse.error,
    });
  }

  // Close delimiter in place — if it already parses, we're done (subject
  // to the safety gate below).
  const afterCloseParse = parseFullDocument(working);
  if (afterCloseParse.ok && applied.length > 0) {
    return finaliseRepair(content, working, applied, {
      candidateRepaired: true,
      parses: true,
    });
  }

  // (2) + (3) YAML-level fixes.
  let workingFrontmatter = postCloseSplit.frontmatterText;

  const dedupedFrontmatter = tryRemoveDuplicateKeys(workingFrontmatter);
  if (dedupedFrontmatter && dedupedFrontmatter !== workingFrontmatter) {
    workingFrontmatter = dedupedFrontmatter;
    applied.push('duplicate-keys');
  }

  const reindentedFrontmatter = tryNormalizeIndentation(workingFrontmatter);
  if (reindentedFrontmatter && reindentedFrontmatter !== workingFrontmatter) {
    workingFrontmatter = reindentedFrontmatter;
    applied.push('indentation-normalize');
  }

  if (!applied.includes('duplicate-keys') && !applied.includes('indentation-normalize')) {
    // No YAML-level change. State equals after (1). Report based on that.
    return finaliseRepair(content, working, applied, {
      candidateRepaired: afterCloseParse.ok && applied.length > 0,
      parses: afterCloseParse.ok,
      parseError: afterCloseParse.ok ? undefined : afterCloseParse.error,
    });
  }

  const reassembled = reassembleFile(postCloseSplit, workingFrontmatter).toString('utf8');
  const finalParse = parseFullDocument(reassembled);
  if (!finalParse.ok) {
    // YAML-level repairs didn't actually fix the doc. Roll back to the
    // post-(1) state — only retain the missing-close fix if it alone
    // yielded a parseable document.
    const rolledBack = applied.includes('missing-closing-delimiter')
      ? (['missing-closing-delimiter'] as MechanicalRepairFix[])
      : ([] as MechanicalRepairFix[]);
    return finaliseRepair(content, working, rolledBack, {
      candidateRepaired: afterCloseParse.ok && applied.includes('missing-closing-delimiter'),
      parses: afterCloseParse.ok,
      parseError: afterCloseParse.ok ? undefined : afterCloseParse.error,
    });
  }

  return finaliseRepair(content, reassembled, applied, {
    candidateRepaired: true,
    parses: true,
  });
}

/**
 * Wrap a candidate repair result with the S3-F1 safety gate. When the
 * candidate is not marked as repaired (either no fixes applied, or the
 * parse still fails), it's returned unchanged. When the candidate IS
 * repaired, both the fidelity check and the body-plausibility heuristic
 * (for missing-close repairs) must pass. A rejection resets `newContent`
 * to the original input so callers never see a poisoned candidate.
 */
function finaliseRepair(
  originalContent: string,
  candidateContent: string,
  appliedFixes: MechanicalRepairFix[],
  candidate: { candidateRepaired: boolean; parses: boolean; parseError?: string },
): MechanicalRepairOutput {
  const base: MechanicalRepairOutput = {
    repaired: candidate.candidateRepaired,
    newContent: candidateContent,
    appliedFixes,
    parses: candidate.parses,
    parseError: candidate.parseError,
  };
  if (!candidate.candidateRepaired) return base;

  const safety = validateRepairSafety(originalContent, candidateContent, appliedFixes);
  if (safety.ok) return base;

  return {
    repaired: false,
    // Reset to the ORIGINAL bytes so callers that write `newContent`
    // unconditionally can't clobber the file with a rejected candidate.
    newContent: originalContent,
    appliedFixes: [],
    parses: candidate.parses,
    parseError: candidate.parseError,
    rejectionReason: safety.reason,
    rejectionDetail: safety.detail,
  };
}

/**
 * Run the S3-F1 safety checks against a candidate repair. Returns `ok: true`
 * when the repair is safe to apply; otherwise carries a machine-stable
 * rejection reason plus human-readable detail.
 *
 * The checks are deliberately conservative: when a split can't even parse
 * the "original" (e.g. the mechanical layer had no work to do), we skip
 * the fidelity compare — there's nothing to compare against. Body-
 * absorption is only inspected when the repair claims to have inserted a
 * missing close delimiter.
 */
export function validateRepairSafety(
  originalContent: string,
  candidateContent: string,
  appliedFixes: MechanicalRepairFix[],
):
  | { ok: true }
  | { ok: false; reason: MechanicalRepairRejection; detail: string } {
  const originalSplit = splitFrontmatter(Buffer.from(originalContent, 'utf8'));
  const candidateSplit = splitFrontmatter(Buffer.from(candidateContent, 'utf8'));

  // If either side can't be split, we don't have enough structure to
  // run the safety gate. In practice the caller only reaches here when
  // both sides are parseable frontmatter blocks; defensive early exits.
  if (!originalSplit || !candidateSplit) return { ok: true };

  const fidelity = compareFrontmatterFidelity(
    originalSplit.frontmatterText,
    candidateSplit.frontmatterText,
  );
  if (!fidelity.ok) {
    return {
      ok: false,
      reason: 'fidelity-check-failed',
      detail: fidelity.detail ?? String(fidelity.reason ?? 'fidelity check failed'),
    };
  }

  if (appliedFixes.includes('missing-closing-delimiter')) {
    if (looksLikeMarkdownBody(candidateSplit.frontmatterText)) {
      return {
        ok: false,
        reason: 'body-absorption-detected',
        detail:
          'new frontmatter region contains markdown body patterns (heading, bullet list, or prose paragraph)',
      };
    }
  }

  return { ok: true };
}

/**
 * Heuristic: does `frontmatterText` look like it accidentally swept up
 * markdown body content?
 *
 * Positive signals — any ONE is enough to flag body-absorption:
 *   - ATX heading line (`#{1,6}\s\S`) at column 0. YAML mapping keys
 *     never start with `#` (which is the YAML comment marker but also a
 *     strong markdown heading signal in the shared-space README.md
 *     corpus this repair layer is scoped to).
 *   - Asterisk-bullet list item (`\*\s\S`). YAML never uses `*` for list
 *     items — it's only used for anchor references.
 *   - Prose paragraph at column 0: no YAML key syntax, no leading dash,
 *     no leading `#`, no delimiter, and the line is long (>40 chars) AND
 *     ends with sentence punctuation (`.`, `!`, `?`). Short lines without
 *     colons are rare in real frontmatter but common in body text.
 *
 * The heuristic MUST be conservative on the false-positive side: we'd
 * rather refuse a borderline repair and fall back to the LLM than write
 * a file that silently moves body content into the YAML region.
 */
export function looksLikeMarkdownBody(frontmatterText: string): boolean {
  const lines = frontmatterText.split(/\r?\n/);
  for (const line of lines) {
    if (/^#{1,6}\s\S/.test(line)) return true;
    if (/^\*\s\S/.test(line)) return true;
    // Prose paragraph check.
    if (line.length <= 40) continue;
    if (/^\s/.test(line)) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('-')) continue;
    if (line.startsWith('...') || line.startsWith('---')) continue;
    if (matchTopLevelKey(line)) continue;
    if (line.includes(':')) continue;
    if (!/[.!?]\s*$/.test(line)) continue;
    return true;
  }
  return false;
}

/**
 * If the file starts with `---\s*$` but has NO closing `---`, try to insert
 * one at the first plausible boundary. Returns the repaired content on
 * success, or `null` when no plausible boundary could be found (or when
 * the input already has a closing delimiter).
 *
 * Candidate positions are ordered from most-likely-to-preserve-the-body
 * to least-conservative:
 *
 *   1. Right after the last line of the contiguous YAML-like run at the
 *      top of the frontmatter. This is the common case — the user wrote
 *      `foo: bar` followed by a blank line and then their markdown body.
 *      Inserting the `---` before the blank line preserves every byte
 *      of the body (including any headings or comments that happen to
 *      look like YAML syntax).
 *   2. Before the first non-YAML, non-blank line encountered after the
 *      initial YAML run. A looser heuristic for files that don't have
 *      a blank separator.
 *   3. At end-of-file, on the chance the whole thing is YAML and the
 *      author forgot the close entirely.
 *
 * For each candidate we insert `---` on its own line and re-parse; the
 * FIRST candidate that yields a parseable document wins. Anything else
 * returns `null` — the caller escalates to the LLM fallback.
 */
export function tryAddMissingClosingDelimiter(content: string): string | null {
  const split = splitFrontmatter(Buffer.from(content, 'utf8'));
  if (!split || !split.hasOpenDelimiter) return null;
  if (split.hasClosingDelimiter) return null;

  const eol = split.lineEnding;
  const lines = split.frontmatterText.split(/\r?\n/);

  const candidateInsertions: number[] = [];
  const addCandidate = (pos: number) => {
    if (pos < 0 || pos > lines.length) return;
    if (!candidateInsertions.includes(pos)) candidateInsertions.push(pos);
  };

  // Candidate 1: after the last contiguous YAML-like line from the start.
  // Walk forward until we hit a blank line OR a line that doesn't look
  // like YAML. Insert the close delimiter AFTER the last YAML line
  // (before the blank / body).
  let lastContiguousYaml = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    if (!isYamlLikeLine(line)) break;
    lastContiguousYaml = i;
  }
  if (lastContiguousYaml >= 0) addCandidate(lastContiguousYaml + 1);

  // Candidate 2: before the first non-YAML, non-blank line encountered
  // anywhere in the remaining content.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (isYamlLikeLine(line)) continue;
    addCandidate(i);
    break;
  }

  // Candidate 3: at end-of-file.
  addCandidate(lines.length);

  for (const position of candidateInsertions) {
    const fmLines = lines.slice(0, position);
    const bodyLines = lines.slice(position);
    const rebuilt =
      `---${eol}` +
      fmLines.join(eol).replace(/\s+$/, '') +
      `${eol}---${eol}` +
      bodyLines.join(eol);
    if (parseFullDocument(rebuilt).ok) {
      const bom = split.leadingBomBytes.toString('utf8');
      return `${bom}${rebuilt}`;
    }
  }

  return null;
}

/**
 * Dedupe top-level keys in a YAML frontmatter fragment. When a key appears
 * more than once at the top level, keep the LAST occurrence and drop the
 * earlier block (key line + any indented continuation / list items).
 *
 * Returns the deduped text on change, the input unchanged when no
 * duplicates were found, or `null` if the input is structurally strange
 * enough that we can't safely edit it.
 */
export function tryRemoveDuplicateKeys(frontmatterText: string): string | null {
  const lines = frontmatterText.split(/\r?\n/);
  // Detect original line ending so we can re-join faithfully.
  const eol = frontmatterText.includes('\r\n') ? '\r\n' : '\n';

  // Find every top-level key and the range of lines that belong to it
  // (the key line + any subsequent indented / list-continuation lines
  // until the next top-level key or blank boundary).
  type Block = { key: string; start: number; endExclusive: number };
  const blocks: Block[] = [];

  for (let i = 0; i < lines.length; i++) {
    const keyMatch = matchTopLevelKey(lines[i]);
    if (!keyMatch) continue;
    const start = i;
    let endExclusive = i + 1;
    while (endExclusive < lines.length) {
      const next = lines[endExclusive];
      if (matchTopLevelKey(next)) break;
      endExclusive++;
    }
    blocks.push({ key: keyMatch, start, endExclusive });
    i = endExclusive - 1;
  }

  // Group by key; drop all but the last block for each key.
  const lastBlockByKey = new Map<string, Block>();
  for (const block of blocks) lastBlockByKey.set(block.key, block);

  const linesToDrop = new Set<number>();
  let anyDuplicates = false;
  for (const block of blocks) {
    if (lastBlockByKey.get(block.key) === block) continue;
    anyDuplicates = true;
    for (let j = block.start; j < block.endExclusive; j++) linesToDrop.add(j);
  }
  if (!anyDuplicates) return frontmatterText;

  const kept = lines.filter((_, idx) => !linesToDrop.has(idx));
  return kept.join(eol);
}

/**
 * Replace hard tabs in the frontmatter text with 2-space indents. YAML is
 * strict about tabs in indentation contexts; converting to spaces is a
 * safe structural rewrite because tabs cannot appear inside scalar
 * indentation in valid YAML anyway.
 *
 * Returns the rewritten text, the input unchanged if there were no tabs,
 * or `null` on no-op safety failure (e.g. input empty).
 */
export function tryNormalizeIndentation(frontmatterText: string): string | null {
  if (!frontmatterText) return null;
  if (!frontmatterText.includes('\t')) return frontmatterText;
  // Each tab becomes 2 spaces. Applied everywhere (not just leading) to
  // keep the transformation simple and idempotent — tabs in YAML scalar
  // values are valid UTF-8 but don't normalise anything useful when
  // preserved, and the end-to-end deep-compare guards against any
  // meaningful value drift anyway.
  return frontmatterText.replace(/\t/g, '  ');
}

// ---------------------------------------------------------------------------
// YAML fidelity compare
// ---------------------------------------------------------------------------

export interface FidelityCompareResult {
  ok: boolean;
  /** Short machine-stable reason when `ok: false`. */
  reason?: 'missing-keys' | 'value-changed' | 'fixed-unparseable';
  detail?: string;
  /** Keys detected in the original but missing from the fixed output. */
  missingKeys?: string[];
  /** Keys whose values materially differ. */
  changedKeys?: string[];
}

/**
 * Compare an original (possibly broken) frontmatter YAML fragment with a
 * fixed version. The fixed version MUST:
 *   - Parse successfully.
 *   - Be a SUPERSET of the original's keys (no silent drops).
 *   - Preserve every original key's value up to date-format / whitespace
 *     / primitive-type normalisation (date strings as Date objects etc.).
 *
 * When the original cannot be parsed, we fall back to a regex-based
 * top-level key extraction and only enforce the superset-of-keys
 * invariant. Value-level drift is impossible to detect without a parse,
 * but the mechanical repair layer runs before the LLM, so in practice the
 * common "broken YAML" case has enough structure for the key extractor.
 */
export function compareFrontmatterFidelity(
  originalFrontmatterText: string,
  fixedFrontmatterText: string,
): FidelityCompareResult {
  const fixedParse = parseFragment(fixedFrontmatterText);
  if (!fixedParse.ok) {
    return {
      ok: false,
      reason: 'fixed-unparseable',
      detail: `fixed YAML does not parse: ${fixedParse.error}`,
    };
  }
  const fixedAttrs = fixedParse.attributes;

  const originalParse = parseFragment(originalFrontmatterText);
  const fixedKeySet = new Set(Object.keys(fixedAttrs));

  if (!originalParse.ok) {
    // Fall back to regex key extraction.
    const originalKeys = extractTopLevelKeys(originalFrontmatterText);
    const missingKeys = originalKeys.filter((k) => !fixedKeySet.has(k));
    if (missingKeys.length > 0) {
      return {
        ok: false,
        reason: 'missing-keys',
        detail: `fixed YAML is missing original keys: ${missingKeys.join(', ')}`,
        missingKeys,
      };
    }
    // Value comparison impossible; accept the superset-of-keys guarantee.
    return { ok: true };
  }

  const originalAttrs = originalParse.attributes;
  const originalKeys = Object.keys(originalAttrs);
  const missingKeys = originalKeys.filter((k) => !fixedKeySet.has(k));
  if (missingKeys.length > 0) {
    return {
      ok: false,
      reason: 'missing-keys',
      detail: `fixed YAML is missing original keys: ${missingKeys.join(', ')}`,
      missingKeys,
    };
  }

  const changedKeys: string[] = [];
  for (const key of originalKeys) {
    if (!deepEqualValues(originalAttrs[key], fixedAttrs[key])) {
      changedKeys.push(key);
    }
  }
  if (changedKeys.length > 0) {
    return {
      ok: false,
      reason: 'value-changed',
      detail: `fixed YAML altered values for keys: ${changedKeys.join(', ')}`,
      changedKeys,
    };
  }

  return { ok: true };
}

/**
 * Regex-based extractor for top-level YAML keys. Used when the document
 * does not parse. Accepts keys of the form `^[A-Za-z_][\w-]*\s*:`.
 */
export function extractTopLevelKeys(frontmatterText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = frontmatterText.split(/\r?\n/);
  for (const line of lines) {
    const m = matchTopLevelKey(line);
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface LineEnd {
  /** Byte offset where the line ends (exclusive of the line terminator). */
  lineEndByte: number;
  /** Byte offset of the next line's first byte. */
  nextByte: number;
  lineEnding: '\n' | '\r\n';
}

function findNextLineEnd(bytes: Buffer, start: number): LineEnd | -1 {
  for (let i = start; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0a /* \n */) {
      return { lineEndByte: i, nextByte: i + 1, lineEnding: '\n' };
    }
    if (b === 0x0d /* \r */) {
      if (i + 1 < bytes.length && bytes[i + 1] === 0x0a) {
        return { lineEndByte: i, nextByte: i + 2, lineEnding: '\r\n' };
      }
      // lone \r is treated as a line ending for robustness.
      return { lineEndByte: i, nextByte: i + 1, lineEnding: '\n' };
    }
  }
  return -1;
}

function isDelimiterLine(text: string): boolean {
  return /^---\s*$/.test(text);
}

/**
 * Returns the top-level key name when `line` starts with `key:` (with no
 * leading whitespace, and the line isn't a comment or delimiter). Returns
 * `null` otherwise.
 *
 * Supports bare keys and single/double-quoted keys:
 *   foo: ...          -> 'foo'
 *   'foo-bar': ...    -> 'foo-bar'
 *   "foo.bar": ...    -> 'foo.bar'
 */
function matchTopLevelKey(line: string): string | null {
  if (!line) return null;
  if (/^\s/.test(line)) return null;
  if (line.startsWith('#')) return null;
  if (line.startsWith('---') || line.startsWith('...')) return null;
  const bare = line.match(/^([A-Za-z_][\w-]*)\s*:(?:\s|$)/);
  if (bare) return bare[1];
  const single = line.match(/^'([^']+)'\s*:(?:\s|$)/);
  if (single) return single[1];
  const dq = line.match(/^"([^"]+)"\s*:(?:\s|$)/);
  if (dq) return dq[1];
  return null;
}

/**
 * Heuristic: does this line plausibly belong inside a YAML mapping?
 *
 * Intentionally does NOT treat `# ...` as YAML-like even though `#` is a
 * YAML comment marker. In real-world markdown files, `#` almost always
 * means "heading" and we don't want the delimiter-insertion heuristic to
 * sweep a heading into the frontmatter. Blank lines are also NOT treated
 * as YAML-like here — a blank line terminates the candidate run so the
 * closing `---` lands in the natural gap between frontmatter and body.
 */
function isYamlLikeLine(line: string): boolean {
  if (line === undefined) return false;
  if (line.startsWith('#')) return false;
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (matchTopLevelKey(line)) return true;
  if (/^\s+/.test(line)) {
    if (trimmed.startsWith('- ') || trimmed === '-') return true;
    if (/^[A-Za-z_][\w-]*\s*:/.test(trimmed)) return true;
    // Indented block-scalar continuation (`>`, `|`, or generic text).
    if (/^[^\s].*$/.test(trimmed)) return true;
  }
  return false;
}

interface ParseOk {
  ok: true;
  attributes: Record<string, unknown>;
  body: string;
}
interface ParseErr {
  ok: false;
  error: string;
}

/**
 * Parse a full document (opening + frontmatter + closing + body) via the
 * shared `fm` engine. Returns a tagged union.
 *
 * Important: when `fm` can't find BOTH delimiters it returns
 * `{ attributes: {}, frontmatter: undefined, body: <full content> }` —
 * we treat that as a non-ok parse so the mechanical layer's
 * missing-close repair has a chance to run. Callers who only care about
 * "do we have a legitimate frontmatter block" can thus rely on `ok`
 * without re-inspecting `frontmatter`.
 */
function parseFullDocument(content: string): ParseOk | ParseErr {
  try {
    const result = fm(content);
    if (result.frontmatter === undefined) {
      return { ok: false, error: 'no frontmatter delimiters detected' };
    }
    const attrs = (result.attributes ?? {}) as Record<string, unknown>;
    if (typeof attrs !== 'object') {
      return { ok: false, error: 'frontmatter parsed to non-object' };
    }
    return { ok: true, attributes: attrs, body: result.body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Parse a bare YAML fragment (no delimiters) by wrapping it in synthetic
 * `---` lines and delegating to `fm`.
 */
function parseFragment(frontmatterText: string): ParseOk | ParseErr {
  // Normalise trailing whitespace so the synthetic close delimiter isn't
  // confused with content.
  const normalised = frontmatterText.replace(/\r?\n+$/, '');
  return parseFullDocument(`---\n${normalised}\n---\n`);
}

/**
 * Deep-equal with the normalisations the plan §Stage 3 explicitly
 * tolerates:
 *   - `Date` objects vs ISO strings -> compared by normalised ISO.
 *   - Strings differing only in whitespace runs -> compared after
 *     collapsing internal whitespace and trimming.
 *   - Primitive coercion (e.g. number vs numeric string) -> NOT
 *     tolerated; callers should treat this as a value change.
 *   - Arrays: strict length + ordered element-wise compare.
 *   - Plain objects: same key set + recursive compare.
 *
 * Null / undefined are treated as equivalent (YAML null round-trips).
 */
export function deepEqualValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  const aIsDate = a instanceof Date;
  const bIsDate = b instanceof Date;
  if (aIsDate || bIsDate) {
    const aIso = aIsDate ? (a as Date).toISOString() : normaliseDateString(a);
    const bIso = bIsDate ? (b as Date).toISOString() : normaliseDateString(b);
    if (aIso === null || bIso === null) return false;
    return aIso === bIso;
  }

  if (typeof a === 'string' && typeof b === 'string') {
    return normaliseString(a) === normaliseString(b);
  }

  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualValues(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao).sort();
    const bKeys = Object.keys(bo).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (!deepEqualValues(ao[aKeys[i]], bo[bKeys[i]])) return false;
    }
    return true;
  }

  return false;
}

function normaliseString(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function normaliseDateString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Atomic write + re-validate (shared between scan-side auto-fix and daily)
// ---------------------------------------------------------------------------

/**
 * Tmp suffix used by every frontmatter-repair atomic write. Shared between
 * the scan-side auto-fix (`spaceService.attemptMechanicalFrontmatterRepairOnDisk`)
 * and the daily maintenance pipeline (`spaceMaintenanceService.repairBrokenFrontmatter`).
 */
export const FRONTMATTER_REPAIR_TMP_SUFFIX = '.rebel-frontmatter-tmp';

/**
 * Subset of `node:fs/promises` that `atomicWriteWithReValidate` uses.
 * Extracted so tests can stub specific failure modes (post-rename parse
 * failure, rename crash, rollback failure) without spinning up a temp
 * filesystem. Production callers pass the default `node:fs/promises`.
 */
export interface AtomicWriteFs {
  open: typeof nodeFs.open;
  readFile: typeof nodeFs.readFile;
  writeFile: typeof nodeFs.writeFile;
  rename: typeof nodeFs.rename;
  unlink: typeof nodeFs.unlink;
}

export interface AtomicWriteOptions {
  /** Injected fs module (defaults to `node:fs/promises`). */
  fs?: AtomicWriteFs;
  /**
   * Error sink. Called with a one-line diagnostic string when a step
   * fails. Defaults to a no-op.
   */
  onError?: (message: string) => void;
}

/**
 * Atomic-write + post-write re-validate. Writes `newContent` to a sibling
 * tmp, fsyncs, hash-verifies, renames over `filePath`, then re-parses the
 * renamed file. If the renamed file does NOT parse as valid frontmatter,
 * the original bytes are restored. Every filesystem primitive goes
 * through the injected `fs` dep so tests can drive failure modes
 * deterministically.
 *
 * Contract:
 *   - On success: the file at `filePath` contains `newContent` and
 *     re-parses cleanly. Returns `true`.
 *   - On any write/hash/rename failure BEFORE the atomic rename: the
 *     original file is untouched. Returns `false`. No rollback needed.
 *   - On post-rename parse failure (S3-F6): the original bytes are
 *     written back via `fs.writeFile(filePath, originalBytes)`. Returns
 *     `false`. If rollback itself fails, the error is forwarded to
 *     `onError` and we still return `false` — callers (health-check) are
 *     responsible for surfacing the degraded state.
 *
 * Shared invariants with Stage 2's `applyAtomicMerge`:
 *   - tmp path = `${filePath}${FRONTMATTER_REPAIR_TMP_SUFFIX}`.
 *   - tmp is fsynced BEFORE hash verify (no in-flight caches).
 *   - rename is the ONLY mutation to `filePath` — never a truncating write.
 */
export async function atomicWriteWithReValidate(
  filePath: string,
  originalBytes: Buffer,
  newContent: Buffer | string,
  options: AtomicWriteOptions = {},
): Promise<boolean> {
  const fs = options.fs ?? nodeFs;
  const onError = options.onError ?? (() => { /* no-op */ });
  const newBytes = typeof newContent === 'string' ? Buffer.from(newContent, 'utf8') : newContent;
  const intendedHash = sha256Hex(newBytes);
  const tmpPath = `${filePath}${FRONTMATTER_REPAIR_TMP_SUFFIX}`;

  // (1) Write + fsync tmp.
  let handle: Awaited<ReturnType<typeof nodeFs.open>> | null = null;
  try {
    handle = await fs.open(tmpPath, 'w');
    await handle.writeFile(newBytes);
    await handle.sync();
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    onError(`tmp write failed for ${filePath}: ${toErrorMessage(err)}`);
    return false;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  // (2) Hash-verify the tmp.
  try {
    const tmpBytes = await fs.readFile(tmpPath);
    if (sha256Hex(tmpBytes) !== intendedHash) {
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      onError(`tmp hash mismatch for ${filePath} — aborting write`);
      return false;
    }
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    onError(`tmp re-read failed for ${filePath}: ${toErrorMessage(err)}`);
    return false;
  }

  // (3) Atomic rename.
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    onError(`rename failed for ${filePath}: ${toErrorMessage(err)}`);
    return false;
  }

  // (4) Re-parse the renamed file. Rollback to the original bytes if the
  // repair did not in fact parse on disk. This is the belt-and-suspenders
  // branch — the mechanical layer validated its output and the LLM path
  // ran the fidelity compare, so we expect to succeed; but we MUST NOT
  // leave a still-broken file on disk.
  try {
    const renamedBytes = await fs.readFile(filePath);
    try {
      fm(renamedBytes.toString('utf8'));
    } catch (parseErr) {
      try {
        await fs.writeFile(filePath, originalBytes);
        onError(
          `post-write re-validate failed for ${filePath} (rolled back): ${toErrorMessage(parseErr)}`,
        );
      } catch (rollbackErr) {
        onError(
          `post-write re-validate failed AND rollback failed for ${filePath}: ${toErrorMessage(rollbackErr)}`,
        );
      }
      return false;
    }
  } catch (err) {
    onError(`post-rename read failed for ${filePath}: ${toErrorMessage(err)}`);
    return false;
  }

  return true;
}

function sha256Hex(bytes: Buffer): string {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
