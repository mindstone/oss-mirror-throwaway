import { describe, expect, it } from 'vitest';

import {
  changelogHasVersionHeading,
  evaluatePromotePreflight,
  type GateName,
  type PromotePreflightFacts,
} from '../promote-preflight';

const SHA = '428259cb8428259cb8428259cb8428259cb84282';

/** All gates affirmatively passing — override one fact per test to exercise a gate. */
function baseFacts(overrides: Partial<PromotePreflightFacts> = {}): PromotePreflightFacts {
  return {
    certifiedSha: SHA,
    shaIsValidCommit: true,
    shaIsAncestorOfDev: true,
    betaCertified: true,
    changelogHeadingAtSha: true,
    mainIsAncestorOfSha: true,
    submodulePointersResolve: true,
    shaVersion: '0.4.49',
    mainVersion: '0.4.48',
    ...overrides,
  };
}

describe('evaluatePromotePreflight', () => {
  it('is eligible when every gate passes', () => {
    const v = evaluatePromotePreflight(baseFacts());
    expect(v.eligible).toBe(true);
    expect(v.blockers).toEqual([]);
    expect(v.gates.every((g) => g.status === 'pass')).toBe(true);
    expect(v.summary).toMatch(/^ELIGIBLE/);
  });

  // Each boolean gate, set to `false`, blocks exactly itself.
  it.each<[GateName, Partial<PromotePreflightFacts>]>([
    ['sha-valid', { shaIsValidCommit: false }],
    ['sha-on-dev', { shaIsAncestorOfDev: false }],
    ['beta-certified', { betaCertified: false }],
    ['changelog-heading', { changelogHeadingAtSha: false }],
    ['fast-forward', { mainIsAncestorOfSha: false }],
    ['submodules-resolve', { submodulePointersResolve: false }],
  ])('blocks on %s when that fact is false', (gate, override) => {
    const v = evaluatePromotePreflight(baseFacts(override));
    expect(v.eligible).toBe(false);
    expect(v.blockers).toContain(gate);
  });

  // FAIL-CLOSED: each boolean gate, set to `null` (could-not-determine), also blocks.
  it.each<[GateName, Partial<PromotePreflightFacts>]>([
    ['sha-valid', { shaIsValidCommit: null }],
    ['sha-on-dev', { shaIsAncestorOfDev: null }],
    ['beta-certified', { betaCertified: null }],
    ['changelog-heading', { changelogHeadingAtSha: null }],
    ['fast-forward', { mainIsAncestorOfSha: null }],
    ['submodules-resolve', { submodulePointersResolve: null }],
  ])('fail-closed: blocks on %s when that fact is null', (gate, override) => {
    const v = evaluatePromotePreflight(baseFacts(override));
    expect(v.eligible).toBe(false);
    const result = v.gates.find((g) => g.gate === gate);
    expect(result?.status).toBe('block');
    expect(result?.reason).toMatch(/could not determine/);
  });

  describe('version-ahead gate', () => {
    it('passes when sha version > main version', () => {
      expect(evaluatePromotePreflight(baseFacts({ shaVersion: '0.5.0', mainVersion: '0.4.48' })).eligible).toBe(true);
    });

    it('blocks when versions are equal', () => {
      const v = evaluatePromotePreflight(baseFacts({ shaVersion: '0.4.48', mainVersion: '0.4.48' }));
      expect(v.blockers).toContain('version-ahead');
    });

    it('blocks when sha version is behind main', () => {
      const v = evaluatePromotePreflight(baseFacts({ shaVersion: '0.4.47', mainVersion: '0.4.48' }));
      expect(v.blockers).toContain('version-ahead');
    });

    it.each([
      ['sha invalid', { shaVersion: 'not-semver', mainVersion: '0.4.48' }],
      ['main invalid', { shaVersion: '0.4.49', mainVersion: 'nope' }],
      ['sha null', { shaVersion: null, mainVersion: '0.4.48' }],
      ['main null', { shaVersion: '0.4.49', mainVersion: null }],
    ])('fail-closed: blocks when %s', (_label, override) => {
      const v = evaluatePromotePreflight(baseFacts(override as Partial<PromotePreflightFacts>));
      expect(v.blockers).toContain('version-ahead');
    });

    // F2: production requires canonical stable X.Y.Z — non-stable forms block even if "ahead".
    it.each([
      ['prerelease sha', { shaVersion: '0.4.50-beta.1' }],
      ['leading-v sha', { shaVersion: 'v0.4.50' }],
      ['build-metadata sha', { shaVersion: '0.4.50+build.7' }],
      ['four-part is fine? no — non X.Y.Z main', { mainVersion: '0.4.48-rc.1' }],
      ['whitespace-padded sha', { shaVersion: ' 0.4.49 ' }],
    ])('fail-closed: blocks non-canonical version (%s)', (_label, override) => {
      const v = evaluatePromotePreflight(baseFacts(override as Partial<PromotePreflightFacts>));
      expect(v.blockers).toContain('version-ahead');
    });
  });

  it('lists every blocker when multiple gates fail', () => {
    const v = evaluatePromotePreflight(
      baseFacts({ shaIsValidCommit: false, submodulePointersResolve: null, shaVersion: '0.4.48' })
    );
    expect(v.eligible).toBe(false);
    expect(v.blockers).toEqual(expect.arrayContaining(['sha-valid', 'submodules-resolve', 'version-ahead']));
  });

  it('summary names the blockers and is never a bare GO', () => {
    const v = evaluatePromotePreflight(baseFacts({ mainIsAncestorOfSha: false }));
    expect(v.summary).toMatch(/^BLOCKED/);
    expect(v.summary).toContain('fast-forward');
    expect(v.summary).not.toMatch(/\bGO\b/);
  });

  it('always evaluates all 7 gates (stable order for evidence)', () => {
    const v = evaluatePromotePreflight(baseFacts());
    expect(v.gates.map((g) => g.gate)).toEqual([
      'sha-valid',
      'sha-on-dev',
      'beta-certified',
      'changelog-heading',
      'fast-forward',
      'submodules-resolve',
      'version-ahead',
    ]);
  });

  // F1: candidate identity must fail closed on its own, even when the caller asserts shaIsValidCommit:true.
  describe('certifiedSha identity (sha-valid gate)', () => {
    it.each([
      ['empty', ''],
      ['short', '428259cb8'],
      ['non-hex', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
      ['whitespace-padded', ' 428259cb8428259cb8428259cb8428259cb84282 '],
      ['uppercase', '428259CB8428259CB8428259CB8428259CB84282'],
    ])('blocks sha-valid for a non-canonical certifiedSha: %s (even with shaIsValidCommit:true)', (_label, certifiedSha) => {
      const v = evaluatePromotePreflight(baseFacts({ certifiedSha, shaIsValidCommit: true }));
      expect(v.eligible).toBe(false);
      expect(v.blockers).toContain('sha-valid');
    });

    it('blocks sha-valid when certifiedSha is missing at runtime (undefined)', () => {
      const v = evaluatePromotePreflight(baseFacts({ certifiedSha: undefined as unknown as string }));
      expect(v.blockers).toContain('sha-valid');
    });
  });

  // F4: runtime-shape robustness — omitted / non-boolean facts must block, not pass.
  describe('runtime-shape robustness (fail-closed)', () => {
    it('blocks when a boolean fact is omitted (undefined)', () => {
      const v = evaluatePromotePreflight(baseFacts({ shaIsAncestorOfDev: undefined as unknown as boolean }));
      expect(v.blockers).toContain('sha-on-dev');
    });

    it('blocks when a boolean fact is a truthy non-boolean', () => {
      const v = evaluatePromotePreflight(baseFacts({ betaCertified: 'yes' as unknown as boolean }));
      expect(v.blockers).toContain('beta-certified');
    });

    it('blocks everything when all facts are null', () => {
      const v = evaluatePromotePreflight({
        certifiedSha: '428259cb8428259cb8428259cb8428259cb84282',
        shaIsValidCommit: null,
        shaIsAncestorOfDev: null,
        betaCertified: null,
        changelogHeadingAtSha: null,
        mainIsAncestorOfSha: null,
        submodulePointersResolve: null,
        shaVersion: null,
        mainVersion: null,
      });
      expect(v.eligible).toBe(false);
      expect(v.blockers.length).toBe(v.gates.length);
    });
  });

  // F3: on an internal error the verdict stays fail-closed AND blockers is non-empty (invariant).
  it('fail-closed on internal error: eligible:false AND blockers non-empty', () => {
    const throwingFacts = {
      get certifiedSha(): string {
        throw new Error('boom');
      },
    } as unknown as PromotePreflightFacts;
    const v = evaluatePromotePreflight(throwingFacts);
    expect(v.eligible).toBe(false);
    expect(v.blockers).toContain('internal-error');
    expect(v.blockers.length).toBeGreaterThan(0);
    expect(v.summary).toMatch(/^BLOCKED/);
  });
});

describe('changelogHasVersionHeading', () => {
  it('matches a present version heading', () => {
    expect(changelogHasVersionHeading('# Changelog\n\n## v0.4.49 — Jun 2026\n\n- thing', '0.4.49')).toBe(true);
  });

  it('matches a bare version heading at end of line', () => {
    expect(changelogHasVersionHeading('## v0.4.49', '0.4.49')).toBe(true);
  });

  it('does not match when only Unreleased is present', () => {
    expect(changelogHasVersionHeading('## Unreleased\n\n- pending', '0.4.49')).toBe(false);
  });

  it('does not match a different version', () => {
    expect(changelogHasVersionHeading('## v0.4.48 — old', '0.4.49')).toBe(false);
  });

  it('escapes dots so they are literal (not any-char)', () => {
    // "0X4X49" must NOT satisfy a request for "0.4.49"
    expect(changelogHasVersionHeading('## v0X4X49', '0.4.49')).toBe(false);
  });

  it('does not match a version that is a prefix of a longer one', () => {
    expect(changelogHasVersionHeading('## v0.4.490', '0.4.49')).toBe(false);
  });

  it('returns false for empty content or version', () => {
    expect(changelogHasVersionHeading('', '0.4.49')).toBe(false);
    expect(changelogHasVersionHeading('## v0.4.49', '')).toBe(false);
  });
});
