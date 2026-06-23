import { describe, expect, it } from 'vitest';

import {
  CHANGELOG_RELATIVE_PATH,
  evaluateChangelogHeadingCurrent,
} from '../check-changelog-heading-current';

const HEADER = '# Changelog\n\nWhat\'s new in Rebel.\n\n---\n\n';

describe('evaluateChangelogHeadingCurrent', () => {
  it('passes when the `## v<version>` heading is present (matches package.json)', () => {
    const content = `${HEADER}## v0.4.49 — Jun 16-18, 2026\n\n- thing\n`;
    const result = evaluateChangelogHeadingCurrent({ version: '0.4.49', content });
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('## v0.4.49');
  });

  it('passes for a bare heading at end of line', () => {
    const result = evaluateChangelogHeadingCurrent({ version: '0.4.49', content: '## v0.4.49' });
    expect(result.ok).toBe(true);
  });

  it('fails when the heading is missing entirely', () => {
    const content = `${HEADER}## v0.4.48 — old\n\n- old thing\n`;
    const result = evaluateChangelogHeadingCurrent({ version: '0.4.49', content });
    expect(result.ok).toBe(false);
    // Message names the expected heading + the path + the package.json version.
    expect(result.reason).toContain("'## v0.4.49'");
    expect(result.reason).toContain(CHANGELOG_RELATIVE_PATH);
    expect(result.reason).toContain('0.4.49');
  });

  it('fails when only an `## Unreleased` section is present, and calls it out', () => {
    const content = `${HEADER}## Unreleased\n\n- pending\n`;
    const result = evaluateChangelogHeadingCurrent({ version: '0.4.49', content });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('## Unreleased');
    expect(result.reason).toContain('## v0.4.49');
  });

  it('does not match a different version', () => {
    const content = `${HEADER}## v0.4.48 — old\n`;
    expect(evaluateChangelogHeadingCurrent({ version: '0.4.50', content }).ok).toBe(false);
  });

  it('does not match a version that is a prefix of a longer one', () => {
    const content = `${HEADER}## v0.4.490 — typo\n`;
    expect(evaluateChangelogHeadingCurrent({ version: '0.4.49', content }).ok).toBe(false);
  });

  it('fail-closed: blank version is a failure, not a silent pass', () => {
    const result = evaluateChangelogHeadingCurrent({ version: '   ', content: '## v0.4.49' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/version/i);
  });

  it('fail-closed: empty content fails (heading absent)', () => {
    const result = evaluateChangelogHeadingCurrent({ version: '0.4.49', content: '' });
    expect(result.ok).toBe(false);
  });

  it('matches minor/major version forms', () => {
    expect(evaluateChangelogHeadingCurrent({ version: '0.5.0', content: '## v0.5.0 — date' }).ok).toBe(true);
    expect(evaluateChangelogHeadingCurrent({ version: '1.0.0', content: '## v1.0.0 — date' }).ok).toBe(true);
  });
});
