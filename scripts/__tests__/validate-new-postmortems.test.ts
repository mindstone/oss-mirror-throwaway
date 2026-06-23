import { describe, expect, it } from 'vitest';
import { checkPostmortemContent } from '../validate-new-postmortems.js';

const VALID_LINE =
  '[BUG-POSTMORTEM] {"bug_id":"260101_x","severity":"low","bug_type":"logic","review_miss":"unknown"}';

describe('checkPostmortemContent', () => {
  it('passes a file with the not-a-postmortem marker even with NO [BUG-POSTMORTEM] line', () => {
    const text =
      '<!-- not-a-postmortem: planning hallucination, no shipped bug -->\n\n# Just prose, no structured line.\n';
    expect(checkPostmortemContent('docs/postmortems/x_postmortem.md', text)).toBeNull();
  });

  it('marker match is case-insensitive and tolerates whitespace', () => {
    const text = '<!--   NOT-A-POSTMORTEM: triage stub -->\nprose\n';
    expect(checkPostmortemContent('docs/postmortems/x_postmortem.md', text)).toBeNull();
  });

  it('FAILS a file WITHOUT the marker and WITHOUT a [BUG-POSTMORTEM] line', () => {
    const text = '# A real postmortem body but no structured line.\n';
    const failure = checkPostmortemContent('docs/postmortems/x_postmortem.md', text);
    expect(failure).not.toBeNull();
    expect(failure?.reason).toBe('no-bug-postmortem-line');
  });

  it('passes a normal postmortem with a valid [BUG-POSTMORTEM] line (no marker needed)', () => {
    const text = `# Body\n\n${VALID_LINE}\n`;
    expect(checkPostmortemContent('docs/postmortems/x_postmortem.md', text)).toBeNull();
  });

  it('still validates bug_id when the marker is absent', () => {
    const text =
      '# Body\n\n[BUG-POSTMORTEM] {"severity":"low","bug_type":"logic"}\n';
    const failure = checkPostmortemContent('docs/postmortems/x_postmortem.md', text);
    expect(failure?.reason).toBe('missing-bug-id');
  });
});
