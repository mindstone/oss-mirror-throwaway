import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  auditPlaceholderConditions,
  checkKnownConditions,
  checkLintRegexParity,
  Snapshot,
} from '../check-known-conditions';
import { KNOWN_CONDITIONS, type ConditionMeta } from '../../src/core/sentry/knownConditions';

function eslintConfigWithKnownConditionRegex(members: string): string {
  return `
const knownStructuredErrorCaptureSelectors = [
  {
    // LOCKSTEP-ANCHOR: regex below mirrors the KnownCondition union members.
    selector: "CallExpression[callee.property.name='captureException'] ObjectExpression > Property[key.name='tags'] > ObjectExpression > Property[key.name='condition'][value.type='Literal'][value.value=/^(${members})$/]",
  },
];
`;
}

function eslintConfigWithoutAnchor(members: string): string {
  return `
const knownStructuredErrorCaptureSelectors = [
  {
    selector: "CallExpression[callee.property.name='captureException'] ObjectExpression > Property[key.name='tags'] > ObjectExpression > Property[key.name='condition'][value.type='Literal'][value.value=/^(${members})$/]",
  },
];
`;
}

describe('checkKnownConditions', () => {
  const baseNow = new Date('2026-05-03T12:00:00Z');

  const baseSnapshot: Snapshot = {
    test_cond: { addedAt: '2026-05-01T00:00:00Z', level: 'warning' }
  };

  const baseRegistry: Record<string, ConditionMeta> = {
    test_cond: {
      owner: '@test',
      description: 'test cond',
      fingerprint: ['test'],
      level: 'warning',
      addedAt: '2026-05-01T00:00:00Z'
    }
  };

  it('1. removed-active: registry deletes an entry whose snapshot has deprecatedAt undefined', () => {
    const { violations } = checkKnownConditions({}, baseSnapshot, { now: baseNow });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('removed-active');
    expect(violations[0].condition).toBe('test_cond');
  });

  it('2. removed-deprecated-too-soon: entry deleted but snapshot removableAfter > now', () => {
    const snap: Snapshot = {
      test_cond: {
        addedAt: '2026-05-01T00:00:00Z',
        deprecatedAt: '2026-05-02T00:00:00Z',
        removableAfter: '2026-06-01T00:00:00Z'
      }
    };
    const { violations } = checkKnownConditions({}, snap, { now: baseNow });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('removed-deprecated-too-soon');
  });

  it('3. removed-deprecated-on-time: entry deleted, snapshot removableAfter < now', () => {
    const snap: Snapshot = {
      test_cond: {
        addedAt: '2026-05-01T00:00:00Z',
        deprecatedAt: '2026-04-01T00:00:00Z',
        removableAfter: '2026-05-01T00:00:00Z'
      }
    };
    const { violations } = checkKnownConditions({}, snap, { now: baseNow });
    expect(violations).toHaveLength(0);
  });

  it('4. added-without-snapshot-update: registry adds entry but snapshot doesnt include it', () => {
    const { violations } = checkKnownConditions(baseRegistry, {}, { now: baseNow });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('added-without-snapshot-update');
  });

  it('5. expired-degraded: expectedDegraded.until < now', () => {
    const registry: Record<string, ConditionMeta> = {
      test_cond: {
        ...baseRegistry.test_cond,
        expectedDegraded: { until: '2026-05-02T00:00:00Z', reason: 'foo' }
      }
    };
    const { violations } = checkKnownConditions(registry, baseSnapshot, { now: baseNow });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('expired-degraded');
  });

  it('6. near-expiry-degraded: expectedDegraded.until within 7 days', () => {
    const registry: Record<string, ConditionMeta> = {
      test_cond: {
        ...baseRegistry.test_cond,
        expectedDegraded: { until: '2026-05-08T00:00:00Z', reason: 'foo' }
      }
    };
    const { violations, warnings } = checkKnownConditions(registry, baseSnapshot, { now: baseNow });
    expect(violations).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('near-expiry-degraded');
  });

  it('7. All-clean state', () => {
    const { violations, warnings } = checkKnownConditions(baseRegistry, baseSnapshot, { now: baseNow });
    expect(violations).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('8. Rename via add+deprecate: snapshot has old condition with future removableAfter; registry has both', () => {
    const snap: Snapshot = {
      old_cond: {
        addedAt: '2026-05-01T00:00:00Z',
        level: 'warning',
        deprecatedAt: '2026-05-02T00:00:00Z',
        removableAfter: '2026-06-01T00:00:00Z'
      },
      new_cond: {
        addedAt: '2026-05-02T00:00:00Z',
        level: 'warning'
      }
    };
    const reg: Record<string, ConditionMeta> = {
      old_cond: {
        ...baseRegistry.test_cond,
        deprecatedAt: '2026-05-02T00:00:00Z',
        removableAfter: '2026-06-01T00:00:00Z'
      },
      new_cond: {
        ...baseRegistry.test_cond,
        addedAt: '2026-05-02T00:00:00Z'
      }
    };

    const { violations, warnings } = checkKnownConditions(reg, snap, { now: baseNow });
    expect(violations).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('9. removed-deprecated-no-removable-after: snapshot has entry with deprecatedAt but no removableAfter', () => {
    const snap: Snapshot = {
      test_cond: {
        addedAt: '2026-05-01T00:00:00Z',
        deprecatedAt: '2026-05-02T00:00:00Z'
      }
    };
    const { violations } = checkKnownConditions({}, snap, { now: baseNow });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('removed-deprecated-no-removable-after');
  });

  it('10. removed-deprecated-malformed-removable-after: snapshot has entry with deprecatedAt and non-date removableAfter', () => {
    const snap: Snapshot = {
      test_cond: {
        addedAt: '2026-05-01T00:00:00Z',
        deprecatedAt: '2026-05-02T00:00:00Z',
        removableAfter: 'not-a-date'
      }
    };
    const { violations } = checkKnownConditions({}, snap, { now: baseNow });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('snapshot-mismatch');
  });

  it('11. near-expiry-7-days boundary: 7 days warns, 8 days does not', () => {
    // 7 days exactly
    const reg7: Record<string, ConditionMeta> = {
      test_cond: {
        ...baseRegistry.test_cond,
        expectedDegraded: { until: '2026-05-10T12:00:00Z', reason: 'foo' } // 2026-05-03T12:00:00Z + 7 days
      }
    };
    const res7 = checkKnownConditions(reg7, baseSnapshot, { now: baseNow });
    expect(res7.warnings).toHaveLength(1);
    expect(res7.warnings[0].kind).toBe('near-expiry-degraded');

    // 8 days
    const reg8: Record<string, ConditionMeta> = {
      test_cond: {
        ...baseRegistry.test_cond,
        expectedDegraded: { until: '2026-05-11T12:00:00Z', reason: 'foo' } // 2026-05-03T12:00:00Z + 8 days
      }
    };
    const res8 = checkKnownConditions(reg8, baseSnapshot, { now: baseNow });
    expect(res8.warnings).toHaveLength(0);
  });

  it('13. level-or-sink-mismatch: registry re-levels an entry without snapshot regen', () => {
    const registry: Record<string, ConditionMeta> = {
      test_cond: {
        ...baseRegistry.test_cond,
        level: 'error'
      }
    };
    const { violations } = checkKnownConditions(registry, baseSnapshot, { now: baseNow });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('level-or-sink-mismatch');
    expect(violations[0].condition).toBe('test_cond');
    expect(violations[0].detail).toContain('level (snapshot: warning, registry: error)');
    expect(violations[0].recoveryHint).toContain('regenerate:known-conditions-snapshot');
  });

  it('14. level-or-sink-mismatch: info entry flips sink without snapshot regen', () => {
    const snap: Snapshot = {
      info_cond: { addedAt: '2026-05-01T00:00:00Z', level: 'info', sink: 'issue-stream' }
    };
    const registry: Record<string, ConditionMeta> = {
      info_cond: {
        owner: '@test',
        description: 'info cond',
        fingerprint: ['info-cond'],
        level: 'info',
        sink: 'ledger-only',
        addedAt: '2026-05-01T00:00:00Z'
      }
    };
    const { violations } = checkKnownConditions(registry, snap, { now: baseNow });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('level-or-sink-mismatch');
    expect(violations[0].detail).toContain('sink (snapshot: issue-stream, registry: ledger-only)');
  });

  it('15. level-or-sink-mismatch: snapshot entry missing level for a live condition (forces regen)', () => {
    const snap: Snapshot = {
      test_cond: { addedAt: '2026-05-01T00:00:00Z' }
    };
    const { violations } = checkKnownConditions(baseRegistry, snap, { now: baseNow });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('level-or-sink-mismatch');
    expect(violations[0].detail).toContain('<missing>');
  });

  it('16. info entry with matching level+sink in snapshot is clean', () => {
    const snap: Snapshot = {
      info_cond: { addedAt: '2026-05-01T00:00:00Z', level: 'info', sink: 'ledger-only' }
    };
    const registry: Record<string, ConditionMeta> = {
      info_cond: {
        owner: '@test',
        description: 'info cond',
        fingerprint: ['info-cond'],
        level: 'info',
        sink: 'ledger-only',
        addedAt: '2026-05-01T00:00:00Z'
      }
    };
    const { violations, warnings } = checkKnownConditions(registry, snap, { now: baseNow });
    expect(violations).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('12. S7 recovery-text content for expired-degraded', () => {
    const registry: Record<string, ConditionMeta> = {
      test_cond: {
        ...baseRegistry.test_cond,
        expectedDegraded: { until: '2026-05-02T00:00:00Z', reason: 'original reason here' }
      }
    };
    const { violations } = checkKnownConditions(registry, baseSnapshot, { now: baseNow });
    expect(violations).toHaveLength(1);
    const hint = violations[0].recoveryHint;
    expect(hint).toContain('test_cond');
    expect(hint).toContain('@test');
    expect(hint).toContain('2026-05-02T00:00:00Z');
    expect(hint).toContain('original reason here');
    expect(
      hint.includes('bump') ||
      hint.includes('remove `expectedDegraded`') ||
      hint.includes('deprecatedAt')
    ).toBe(true);
  });
});

describe('checkLintRegexParity', () => {
  it('passes when the ESLint known-condition tag regex matches the live registry', () => {
    const eslintConfigText = eslintConfigWithKnownConditionRegex(
      Object.keys(KNOWN_CONDITIONS).join('|'),
    );

    const violations = checkLintRegexParity(eslintConfigText, KNOWN_CONDITIONS);

    expect(violations).toHaveLength(0);
  });

  it('fails when the ESLint known-condition tag regex is missing a registry key', () => {
    const eslintConfigText = eslintConfigWithKnownConditionRegex(
      'model_error|codex_disconnected_bts|runtime_activity_mapper_failure',
    );

    const violations = checkLintRegexParity(eslintConfigText, KNOWN_CONDITIONS);

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('lint-regex-out-of-lockstep');
    expect(violations[0].subKind).toBe('members-out-of-lockstep');
    expect(violations[0].recoveryHint).toContain('eslint.config.mjs');
    expect(violations[0].recoveryHint).toContain('src/core/sentry/knownConditions.ts');
  });

  it('fails when the ESLint known-condition tag regex contains a key not in the registry', () => {
    const eslintConfigText = eslintConfigWithKnownConditionRegex(
      'model_error|codex_disconnected_bts|runtime_activity_mapper_failure|cloud_outbox_stuck|extraneous_unregistered_condition',
    );

    const violations = checkLintRegexParity(eslintConfigText, KNOWN_CONDITIONS);

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('lint-regex-out-of-lockstep');
    expect(violations[0].subKind).toBe('members-out-of-lockstep');
    expect(violations[0].detail).toContain('extraneous_unregistered_condition');
    expect(violations[0].recoveryHint).toContain('eslint.config.mjs');
    expect(violations[0].recoveryHint).toContain('src/core/sentry/knownConditions.ts');
  });

  it('fails with anchor-missing sub-kind when the LOCKSTEP-ANCHOR comment is absent', () => {
    const eslintConfigText = eslintConfigWithoutAnchor(
      'model_error|codex_disconnected_bts|runtime_activity_mapper_failure|cloud_outbox_stuck',
    );

    const violations = checkLintRegexParity(eslintConfigText, KNOWN_CONDITIONS);

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('lint-regex-out-of-lockstep');
    expect(violations[0].subKind).toBe('anchor-missing');
    expect(violations[0].detail).toContain('LOCKSTEP-ANCHOR');
    expect(violations[0].recoveryHint).toContain('eslint.config.mjs');
  });
});

describe('mergeSnapshot (regenerate script merge-only invariant)', () => {
  // Phase 7 general-reviewer must-fix: regenerate must never drop existing
  // snapshot entries. This closes the "delete from registry + regenerate
  // snapshot in same change" bypass of append-only enforcement.

  let mergeSnapshot: typeof import('../regenerate-known-conditions-snapshot').mergeSnapshot;

  beforeAll(async () => {
    ({ mergeSnapshot } = await import('../regenerate-known-conditions-snapshot'));
  });

  const baseRegistryEntry: ConditionMeta = {
    owner: '@test',
    description: 'test',
    fingerprint: ['test'],
    level: 'warning',
    addedAt: '2026-05-01T00:00:00Z',
  };

  it('preserves snapshot entries that are no longer in the live registry', () => {
    const existing = {
      retired_cond: { addedAt: '2026-04-01T00:00:00Z' },
      live_cond: { addedAt: '2026-05-01T00:00:00Z' },
    };
    const registry = { live_cond: baseRegistryEntry };
    const { merged, preservedTombstones } = mergeSnapshot(existing, registry);
    expect(merged).toHaveProperty('retired_cond');
    expect(merged.retired_cond).toEqual({ addedAt: '2026-04-01T00:00:00Z' });
    expect(preservedTombstones).toEqual(['retired_cond']);
  });

  it('updates existing entries when registry metadata changes', () => {
    const existing = { live_cond: { addedAt: '2026-05-01T00:00:00Z' } };
    const registry = {
      live_cond: {
        ...baseRegistryEntry,
        deprecatedAt: '2026-05-15T00:00:00Z',
        removableAfter: '2026-06-14T00:00:00Z',
      },
    };
    const { merged } = mergeSnapshot(existing, registry);
    expect(merged.live_cond).toEqual({
      addedAt: '2026-05-01T00:00:00Z',
      level: 'warning',
      deprecatedAt: '2026-05-15T00:00:00Z',
      removableAfter: '2026-06-14T00:00:00Z',
    });
  });

  it('writes level (and sink for info entries) into snapshot entries', () => {
    const registry: Record<string, ConditionMeta> = {
      warn_cond: baseRegistryEntry,
      info_cond: {
        owner: '@test',
        description: 'test',
        fingerprint: ['test'],
        level: 'info',
        sink: 'ledger-only',
        addedAt: '2026-05-01T00:00:00Z',
      },
    };
    const { merged } = mergeSnapshot({}, registry);
    expect(merged.warn_cond).toEqual({ addedAt: '2026-05-01T00:00:00Z', level: 'warning' });
    expect(merged.info_cond).toEqual({
      addedAt: '2026-05-01T00:00:00Z',
      level: 'info',
      sink: 'ledger-only',
    });
  });

  it('adds new registry entries to the merged snapshot', () => {
    const existing = { existing_cond: { addedAt: '2026-04-01T00:00:00Z' } };
    const registry = {
      existing_cond: { ...baseRegistryEntry, addedAt: '2026-04-01T00:00:00Z' },
      new_cond: baseRegistryEntry,
    };
    const { merged, preservedTombstones } = mergeSnapshot(existing, registry);
    expect(merged).toHaveProperty('existing_cond');
    expect(merged).toHaveProperty('new_cond');
    expect(preservedTombstones).toEqual([]);
  });

  it('integration: regenerated snapshot still triggers removed-active violation when registry deletion is attempted', () => {
    // This is the bypass that the merge-only behavior closes:
    // 1. Developer removes entry from registry.
    // 2. Developer runs regenerate (merge-only — preserves the removed entry).
    // 3. checkKnownConditions sees snapshot has it but live doesn't → fails.
    const existing = { active_cond: { addedAt: '2026-05-01T00:00:00Z' } };
    const registryAfterDelete: Record<string, ConditionMeta> = {};
    const { merged } = mergeSnapshot(existing, registryAfterDelete);
    expect(merged).toHaveProperty('active_cond');
    const { violations } = checkKnownConditions(registryAfterDelete, merged, {
      now: new Date('2026-05-03T12:00:00Z'),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('removed-active');
  });

  it('sorts merged keys alphabetically for stable diffs', () => {
    const existing = { z_cond: { addedAt: '2026-05-01T00:00:00Z' } };
    const registry = {
      a_cond: baseRegistryEntry,
      m_cond: baseRegistryEntry,
    };
    const { merged } = mergeSnapshot(existing, registry);
    expect(Object.keys(merged)).toEqual(['a_cond', 'm_cond', 'z_cond']);
  });
});

describe('auditPlaceholderConditions (Stage 3 audit-only)', () => {
  let scratchRoot: string;

  function makeRegistryEntry(addedAt: string): ConditionMeta {
    return {
      owner: '@test',
      description: 'audit-test',
      fingerprint: ['audit-test'],
      level: 'warning',
      addedAt,
    };
  }

  function writeFile(relPath: string, content: string): void {
    const full = path.join(scratchRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-placeholder-'));
    // Auditor scans `src`, `cloud-service`, `cloud-client`, `mobile`. Bare-init
    // those directories so the walker finds them under our scratch root.
    fs.mkdirSync(path.join(scratchRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('reports an entry as a placeholder when no production callsite invokes it', () => {
    writeFile('src/main/services/wired.ts', `
      import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
      function emit(): void {
        captureKnownCondition('wired_cond', {}, new Error('x'));
      }
    `);

    const registry: Record<string, ConditionMeta> = {
      wired_cond: makeRegistryEntry('2026-05-01T00:00:00Z'),
      placeholder_cond: makeRegistryEntry('2026-05-01T00:00:00Z'),
    };

    const audit = auditPlaceholderConditions(scratchRoot, registry);

    expect(audit.placeholders).toEqual(['placeholder_cond']);
    expect(audit.callsiteCounts).toEqual({
      placeholder_cond: 0,
      wired_cond: 1,
    });
  });

  it('does NOT count callsites in test files (__tests__, *.test.ts, *.spec.ts)', () => {
    // A test fixture invoking captureKnownCondition must not mask a missing
    // production callsite. This is the central correctness invariant.
    writeFile('src/core/sentry/__tests__/captureKnownCondition.test.ts', `
      captureKnownCondition('placeholder_cond', {}, new Error('x'));
    `);
    writeFile('src/core/services/foo.test.ts', `
      captureKnownCondition('placeholder_cond', {}, new Error('x'));
    `);
    writeFile('src/core/services/bar.spec.ts', `
      captureKnownCondition('placeholder_cond', {}, new Error('x'));
    `);

    const registry: Record<string, ConditionMeta> = {
      placeholder_cond: makeRegistryEntry('2026-05-01T00:00:00Z'),
    };

    const audit = auditPlaceholderConditions(scratchRoot, registry);

    expect(audit.placeholders).toEqual(['placeholder_cond']);
    expect(audit.callsiteCounts.placeholder_cond).toBe(0);
  });

  it('does NOT count strings in comments or docstrings (AST-based, not regex)', () => {
    writeFile('src/main/services/onlyComments.ts', `
      // captureKnownCondition('placeholder_cond', {}, new Error('x'));
      /*
       * captureKnownCondition('placeholder_cond', {}, new Error('y'));
       */
      /** JSDoc: see captureKnownCondition('placeholder_cond', ...). */
      const COMMENTED_NAME = 'placeholder_cond';
      void COMMENTED_NAME;
    `);

    const registry: Record<string, ConditionMeta> = {
      placeholder_cond: makeRegistryEntry('2026-05-01T00:00:00Z'),
    };

    const audit = auditPlaceholderConditions(scratchRoot, registry);

    expect(audit.placeholders).toEqual(['placeholder_cond']);
    expect(audit.callsiteCounts.placeholder_cond).toBe(0);
  });

  it('does NOT count callsites where the first argument is dynamic (template literal / variable)', () => {
    // Audit only counts string-literal first arguments. Dynamic dispatch is
    // intentionally invisible to the audit (would otherwise produce false
    // positives that can't be attributed to a specific registry key).
    writeFile('src/main/services/dynamic.ts', `
      const cond = 'placeholder_cond' as const;
      captureKnownCondition(cond, {}, new Error('x'));
      captureKnownCondition(\`placeholder_cond\`, {}, new Error('y'));
    `);

    const registry: Record<string, ConditionMeta> = {
      placeholder_cond: makeRegistryEntry('2026-05-01T00:00:00Z'),
    };

    const audit = auditPlaceholderConditions(scratchRoot, registry);

    expect(audit.placeholders).toEqual(['placeholder_cond']);
    expect(audit.callsiteCounts.placeholder_cond).toBe(0);
  });

  it('counts inline `as const` / parenthesized / type-asserted string-literal first arguments', () => {
    // Value-preserving wrappers (as const, type assertion, parens, satisfies)
    // do not change the runtime first argument. Treat them as equivalent to a
    // bare string literal so we don't false-positive a real callsite as a
    // placeholder.
    writeFile('src/main/services/inline-wrapped.ts', `
      captureKnownCondition('cond_a' as const, {}, new Error('a'));
      captureKnownCondition(<const>'cond_b', {}, new Error('b'));
      captureKnownCondition(('cond_c'), {}, new Error('c'));
      captureKnownCondition('cond_d' satisfies string, {}, new Error('d'));
    `);

    const registry: Record<string, ConditionMeta> = {
      cond_a: makeRegistryEntry('2026-05-01T00:00:00Z'),
      cond_b: makeRegistryEntry('2026-05-01T00:00:00Z'),
      cond_c: makeRegistryEntry('2026-05-01T00:00:00Z'),
      cond_d: makeRegistryEntry('2026-05-01T00:00:00Z'),
    };

    const audit = auditPlaceholderConditions(scratchRoot, registry);

    expect(audit.placeholders).toEqual([]);
    expect(audit.callsiteCounts).toEqual({
      cond_a: 1,
      cond_b: 1,
      cond_c: 1,
      cond_d: 1,
    });
  });

  it('returns an empty placeholders list when every registry entry has at least one callsite', () => {
    writeFile('src/main/services/a.ts', `
      captureKnownCondition('cond_a', {}, new Error('x'));
    `);
    writeFile('src/main/services/b.ts', `
      captureKnownCondition('cond_b', {}, new Error('x'));
      captureKnownCondition('cond_b', {}, new Error('y'));
    `);

    const registry: Record<string, ConditionMeta> = {
      cond_a: makeRegistryEntry('2026-05-01T00:00:00Z'),
      cond_b: makeRegistryEntry('2026-05-01T00:00:00Z'),
    };

    const audit = auditPlaceholderConditions(scratchRoot, registry);

    expect(audit.placeholders).toEqual([]);
    expect(audit.callsiteCounts).toEqual({ cond_a: 1, cond_b: 2 });
  });

  it('ignores literals that are not registered conditions (avoids false-positive miscounts)', () => {
    writeFile('src/main/services/foo.ts', `
      captureKnownCondition('not_a_known_condition', {}, new Error('x'));
      captureKnownCondition('placeholder_cond', {}, new Error('y'));
    `);

    const registry: Record<string, ConditionMeta> = {
      placeholder_cond: makeRegistryEntry('2026-05-01T00:00:00Z'),
    };

    const audit = auditPlaceholderConditions(scratchRoot, registry);

    expect(audit.placeholders).toEqual([]);
    expect(audit.callsiteCounts).toEqual({ placeholder_cond: 1 });
  });

  it('returns sorted placeholder names and sorted callsite-count keys for stable output', () => {
    writeFile('src/main/services/a.ts', `
      captureKnownCondition('m_cond', {}, new Error('x'));
    `);

    const registry: Record<string, ConditionMeta> = {
      z_cond: makeRegistryEntry('2026-05-01T00:00:00Z'),
      a_cond: makeRegistryEntry('2026-05-01T00:00:00Z'),
      m_cond: makeRegistryEntry('2026-05-01T00:00:00Z'),
    };

    const audit = auditPlaceholderConditions(scratchRoot, registry);

    expect(audit.placeholders).toEqual(['a_cond', 'z_cond']);
    expect(Object.keys(audit.callsiteCounts)).toEqual(['a_cond', 'm_cond', 'z_cond']);
  });
});
