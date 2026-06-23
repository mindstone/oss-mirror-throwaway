import { describe, expect, it } from 'vitest';
import { extractAugmentLines } from '../validate-new-augmentations.js';

const AUGMENT_LINE =
  '[BUG-POSTMORTEM-AUGMENT] {"bug_id":"260531_x","augmented_at":"260531","contract_surfaces_crossed":["schema","build_tooling"],"surfaces_count":2}';

describe('extractAugmentLines', () => {
  it('extracts the bug_id from a single valid augment line', () => {
    const text = `# Body\n\n${AUGMENT_LINE}\n`;
    const { bugIds, malformed } = extractAugmentLines(text);
    expect(bugIds).toEqual(['260531_x']);
    expect(malformed).toEqual([]);
  });

  it('returns empty when there is no augment line (augment layer is optional)', () => {
    const text =
      '# Body\n\n[BUG-POSTMORTEM] {"bug_id":"260101_x","severity":"low"}\n';
    const { bugIds, malformed } = extractAugmentLines(text);
    expect(bugIds).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it('enumerates ALL augment lines in a bundled postmortem (not just the first)', () => {
    const a =
      '[BUG-POSTMORTEM-AUGMENT] {"bug_id":"260531_a","surfaces_count":1}';
    const b =
      '[BUG-POSTMORTEM-AUGMENT] {"bug_id":"260531_b","surfaces_count":1}';
    const c =
      '[BUG-POSTMORTEM-AUGMENT] {"bug_id":"260531_c","surfaces_count":1}';
    const text = `# Body\n\n${a}\n${b}\n${c}\n`;
    const { bugIds, malformed } = extractAugmentLines(text);
    expect(bugIds).toEqual(['260531_a', '260531_b', '260531_c']);
    expect(malformed).toEqual([]);
  });

  it('flags a malformed augment-line JSON as malformed (must not be silently skipped)', () => {
    const text = '# Body\n\n[BUG-POSTMORTEM-AUGMENT] {not valid json}\n';
    const { bugIds, malformed } = extractAugmentLines(text);
    expect(bugIds).toEqual([]);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toContain('unparseable JSON');
  });

  it('flags an augment line lacking a bug_id as malformed', () => {
    const text =
      '# Body\n\n[BUG-POSTMORTEM-AUGMENT] {"augmented_at":"260531","surfaces_count":1}\n';
    const { bugIds, malformed } = extractAugmentLines(text);
    expect(bugIds).toEqual([]);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toContain('bug_id');
  });

  it('flags an augment line with an empty/whitespace bug_id as malformed', () => {
    const text =
      '# Body\n\n[BUG-POSTMORTEM-AUGMENT] {"bug_id":"   ","surfaces_count":0}\n';
    const { bugIds, malformed } = extractAugmentLines(text);
    expect(bugIds).toEqual([]);
    expect(malformed).toHaveLength(1);
  });

  it('trims surrounding whitespace from the extracted bug_id', () => {
    const text =
      '# Body\n\n[BUG-POSTMORTEM-AUGMENT] {"bug_id":"  260531_x  ","surfaces_count":0}\n';
    const { bugIds } = extractAugmentLines(text);
    expect(bugIds).toEqual(['260531_x']);
  });

  it('collects valid and malformed lines together in a mixed file', () => {
    const good =
      '[BUG-POSTMORTEM-AUGMENT] {"bug_id":"260531_good","surfaces_count":1}';
    const bad = '[BUG-POSTMORTEM-AUGMENT] {oops';
    const text = `# Body\n\n${good}\n${bad}\n`;
    const { bugIds, malformed } = extractAugmentLines(text);
    expect(bugIds).toEqual(['260531_good']);
    expect(malformed).toHaveLength(1);
  });

  it('treats a marker-only line as malformed, not swallowing the next line', () => {
    // A bare marker with nothing after it must read as an empty (malformed)
    // payload — the gap matcher must not consume the newline and grab the
    // following line's content as this marker's payload.
    const text =
      '# Body\n\n[BUG-POSTMORTEM-AUGMENT]\n{"bug_id":"260531_next","surfaces_count":1}\n';
    const { bugIds, malformed } = extractAugmentLines(text);
    expect(bugIds).toEqual([]);
    expect(malformed).toHaveLength(1);
  });

  it('extracts the augment bug_id even when a [BUG-POSTMORTEM] line precedes it', () => {
    const text =
      '# Body\n\n[BUG-POSTMORTEM] {"bug_id":"260531_x","severity":"medium"}\n' +
      `${AUGMENT_LINE}\n`;
    const { bugIds } = extractAugmentLines(text);
    expect(bugIds).toEqual(['260531_x']);
  });
});
