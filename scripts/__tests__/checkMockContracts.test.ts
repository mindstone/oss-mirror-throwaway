/**
 * Unit + integration coverage for the mock-contract guard
 * (scripts/checks/checkMockContracts.ts, Stage 10 of
 * docs/plans/260610_testing-recs-drain).
 *
 * Fixtures use FIXTURE module paths ('@fixture/widget'), never the real
 * curated aliases — the repo-wide scan reads this file too (it contains
 * `vi.mock(` in template literals), and fixture specifiers must not match
 * the production registry.
 */
import { describe, it, expect } from 'vitest';
import {
  MOCK_CONTRACT_REGISTRY,
  PARTIAL_ANNOTATION_RE,
  classifyFactory,
  evaluateAgainstBaseline,
  extractMockFactories,
  scanRepo,
  scanSourceForViolations,
  violationKey,
  type MockContractModuleEntry,
} from '../checks/checkMockContracts';

const FIXTURE_REGISTRY: readonly MockContractModuleEntry[] = [
  {
    modulePath: '@fixture/widget',
    specifierSuffixes: ['fixture/widget'],
    productionCalledExports: ['makeWidget', 'resetWidget'],
  },
];

const REQUIRED = FIXTURE_REGISTRY[0].productionCalledExports;

function siteFor(source: string, index = 0) {
  const sites = extractMockFactories(source);
  expect(sites.length).toBeGreaterThan(index);
  return sites[index];
}

describe('extractMockFactories', () => {
  it('extracts bare automock calls with a null factory', () => {
    const sites = extractMockFactories(`vi.mock('@fixture/widget');\n`);
    expect(sites).toHaveLength(1);
    expect(sites[0].specifier).toBe('@fixture/widget');
    expect(sites[0].factoryText).toBeNull();
  });

  it('extracts multi-line factories with nested parens, strings and comments', () => {
    const source = [
      `const a = 1;`,
      `vi.mock('@fixture/widget', () => ({`,
      `  makeWidget: (...args: unknown[]) => mockMake(...args), // trailing ) comment`,
      `  label: 'a (paren) inside a string',`,
      `  resetWidget: vi.fn(),`,
      `}));`,
      `vi.mock('@fixture/other');`,
    ].join('\n');
    const sites = extractMockFactories(source);
    expect(sites).toHaveLength(2);
    expect(sites[0].line).toBe(2);
    expect(sites[0].factoryText).toContain('makeWidget');
    expect(sites[0].factoryText).toContain('resetWidget');
    expect(sites[1].specifier).toBe('@fixture/other');
    expect(sites[1].factoryText).toBeNull();
  });

  it('captures the 3 preceding lines as the annotation window', () => {
    const source = [`// one`, `// two`, `// three`, `vi.mock('@fixture/widget', () => ({}));`].join(
      '\n',
    );
    expect(siteFor(source).precedingLines).toEqual(['// one', '// two', '// three']);
  });
});

describe('classifyFactory — the four contract classifications', () => {
  it('(automock) bare vi.mock is OK', () => {
    const site = siteFor(`vi.mock('@fixture/widget');\n`);
    expect(classifyFactory(site, REQUIRED)).toEqual({ kind: 'automock' });
  });

  it('(a) spreading importOriginal is OK regardless of provided keys', () => {
    const source = [
      `vi.mock('@fixture/widget', async (importOriginal) => ({`,
      `  ...(await importOriginal<object>()),`,
      `  makeWidget: vi.fn(),`,
      `}));`,
    ].join('\n');
    expect(classifyFactory(siteFor(source), REQUIRED)).toEqual({ kind: 'spreads-original' });
  });

  it('(a) vi.importActual is OK too', () => {
    const source = [
      `vi.mock('@fixture/widget', async () => {`,
      `  const actual = await vi.importActual<object>('@fixture/widget');`,
      `  return { ...actual };`,
      `});`,
    ].join('\n');
    expect(classifyFactory(siteFor(source), REQUIRED)).toEqual({ kind: 'spreads-original' });
  });

  it('(a-NEGATIVE) the importOriginal token WITHOUT a spread is a violation (review F1)', () => {
    // The GPT-review false-pass shape: importOriginal appears only as an
    // (unused) factory parameter; nothing is spread.
    const source = [
      `vi.mock('@fixture/widget', async (importOriginal) => ({`,
      `  makeWidget: vi.fn(),`,
      `}));`,
    ].join('\n');
    expect(classifyFactory(siteFor(source), REQUIRED)).toEqual({
      kind: 'violation',
      missingExports: ['resetWidget'],
    });
  });

  it('(a-NEGATIVE) awaiting the original without spreading it is a violation', () => {
    const source = [
      `vi.mock('@fixture/widget', async () => {`,
      `  const actual = await vi.importActual<object>('@fixture/widget');`,
      `  void actual;`,
      `  return { makeWidget: vi.fn() };`,
      `});`,
    ].join('\n');
    expect(classifyFactory(siteFor(source), REQUIRED)).toEqual({
      kind: 'violation',
      missingExports: ['resetWidget'],
    });
  });

  it('(a-NEGATIVE) spreading an UNRELATED identifier while the token is present is a violation', () => {
    const source = [
      `vi.mock('@fixture/widget', async (importOriginal) => {`,
      `  const extras = { other: 1 };`,
      `  return { ...extras, makeWidget: vi.fn() };`,
      `});`,
    ].join('\n');
    expect(classifyFactory(siteFor(source), REQUIRED)).toEqual({
      kind: 'violation',
      missingExports: ['resetWidget'],
    });
  });

  it('(a-NEGATIVE) binding the original but spreading a different identifier is a violation', () => {
    const source = [
      `vi.mock('@fixture/widget', async () => {`,
      `  const actual = await vi.importActual<object>('@fixture/widget');`,
      `  const partial = { makeWidget: actual };`,
      `  return { ...partial };`,
      `});`,
    ].join('\n');
    expect(classifyFactory(siteFor(source), REQUIRED)).toEqual({
      kind: 'violation',
      missingExports: ['resetWidget'],
    });
  });

  it('(a) direct spread without parens — `...await importOriginal()` — is OK', () => {
    const source = [
      `vi.mock('@fixture/widget', async (importOriginal) => ({`,
      `  ...await importOriginal<object>(),`,
      `}));`,
    ].join('\n');
    expect(classifyFactory(siteFor(source), REQUIRED)).toEqual({ kind: 'spreads-original' });
  });

  it('(b) a `mock-contract: partial` annotation within 3 lines above is OK', () => {
    const source = [
      `// mock-contract: partial — this suite only exercises makeWidget`,
      `vi.mock('@fixture/widget', () => ({ makeWidget: vi.fn() }));`,
    ].join('\n');
    expect(classifyFactory(siteFor(source), REQUIRED)).toEqual({ kind: 'annotated-partial' });
  });

  it('(b) an annotation MORE than 3 lines above does not count', () => {
    const source = [
      `// mock-contract: partial — too far away`,
      ``,
      ``,
      ``,
      `vi.mock('@fixture/widget', () => ({ makeWidget: vi.fn() }));`,
    ].join('\n');
    const classification = classifyFactory(siteFor(source), REQUIRED);
    expect(classification.kind).toBe('violation');
  });

  it('(d-bis) export name in VALUE position does NOT count as provided (final-review F1)', () => {
    // resetWidget appears only as a value / argument — the factory does not
    // export it; the old whitespace-prefix grammar false-passed these shapes.
    for (const body of [
      `{ makeWidget: resetWidget }`,
      `{ other: resetWidget, makeWidget: vi.fn() }`,
      `{ makeWidget: wrap(resetWidget) }`,
    ]) {
      const site = siteFor(`vi.mock('@fixture/widget', () => (${body}));\n`);
      const classification = classifyFactory(site, REQUIRED);
      expect(classification.kind).toBe('violation');
      if (classification.kind === 'violation') {
        expect(classification.missingExports).toContain('resetWidget');
      }
    }
  });

  it('(c-bis) async/getter method keys still count as provided', () => {
    const site = siteFor(
      `vi.mock('@fixture/widget', () => ({ makeWidget: vi.fn(), async resetWidget() { return 1; } }));\n`,
    );
    expect(classifyFactory(site, REQUIRED)).toEqual({ kind: 'provides-all' });
  });

  it('(c) providing every production-called export is OK (key, shorthand, quoted, method)', () => {
    for (const body of [
      `{ makeWidget: vi.fn(), resetWidget: vi.fn() }`,
      `{ makeWidget, resetWidget }`,
      `{ 'makeWidget': vi.fn(), "resetWidget": vi.fn() }`,
      `{ makeWidget() { return 1; }, resetWidget: vi.fn() }`,
    ]) {
      const site = siteFor(`vi.mock('@fixture/widget', () => (${body}));\n`);
      expect(classifyFactory(site, REQUIRED)).toEqual({ kind: 'provides-all' });
    }
  });

  it('(d) anything else is a violation naming the missing exports', () => {
    const site = siteFor(`vi.mock('@fixture/widget', () => ({ makeWidget: vi.fn() }));\n`);
    expect(classifyFactory(site, REQUIRED)).toEqual({
      kind: 'violation',
      missingExports: ['resetWidget'],
    });
  });

  it('(d) an export name appearing only in a comment does not satisfy the contract', () => {
    const source = [
      `vi.mock('@fixture/widget', () => ({`,
      `  // resetWidget deliberately omitted here`,
      `  makeWidget: vi.fn(),`,
      `}));`,
    ].join('\n');
    expect(classifyFactory(siteFor(source), REQUIRED)).toEqual({
      kind: 'violation',
      missingExports: ['resetWidget'],
    });
  });
});

describe('PARTIAL_ANNOTATION_RE', () => {
  it.each([
    ['// mock-contract: partial — only the happy path is mocked', true],
    ['// mock-contract: partial - hyphen variant with reason', true],
    ['// mock-contract: partial —', false], // reason required
    ['// mock-contract: full', false],
    ['// partial — but not the marker', false],
  ])('%s -> %s', (line, expected) => {
    expect(PARTIAL_ANNOTATION_RE.test(line)).toBe(expected);
  });
});

describe('scanSourceForViolations (registry matching)', () => {
  it('matches the alias spelling and relative-suffix spellings; skips other modules', () => {
    const source = [
      `vi.mock('@fixture/widget', () => ({ makeWidget: vi.fn() }));`,
      `vi.mock('../fixture/widget', () => ({ makeWidget: vi.fn() }));`,
      `vi.mock('@other/module', () => ({}));`,
      `vi.mock('./widget', () => ({}));`, // bare basename — deliberately NOT matched
    ].join('\n');
    const result = scanSourceForViolations('x.test.ts', source, FIXTURE_REGISTRY);
    expect(result.curatedFactories).toBe(2);
    expect(result.violations).toEqual([
      { file: 'x.test.ts', modulePath: '@fixture/widget', missingExport: 'resetWidget', line: 1 },
      { file: 'x.test.ts', modulePath: '@fixture/widget', missingExport: 'resetWidget', line: 2 },
    ]);
  });

  it('replays the incident: a module gaining a production-called export flags stale factories', () => {
    // Before: factory satisfies the curated set.
    const source = `vi.mock('@fixture/widget', () => ({ makeWidget: vi.fn(), resetWidget: vi.fn() }));\n`;
    expect(scanSourceForViolations('x.test.ts', source, FIXTURE_REGISTRY).violations).toEqual([]);
    // After: production starts calling recordWidgetLedgerOnly → registry grows → same factory is now a violation.
    const grown: readonly MockContractModuleEntry[] = [
      { ...FIXTURE_REGISTRY[0], productionCalledExports: [...REQUIRED, 'recordWidgetLedgerOnly'] },
    ];
    expect(scanSourceForViolations('x.test.ts', source, grown).violations).toEqual([
      {
        file: 'x.test.ts',
        modulePath: '@fixture/widget',
        missingExport: 'recordWidgetLedgerOnly',
        line: 1,
      },
    ]);
  });
});

describe('evaluateAgainstBaseline (ratchet semantics)', () => {
  const violation = {
    file: 'x.test.ts',
    modulePath: '@fixture/widget',
    missingExport: 'resetWidget',
    line: 1,
  };

  it('baselined violations pass; unbaselined ones are new; fixed entries are stale', () => {
    const baseline = [violationKey(violation), 'gone.test.ts :: @fixture/widget :: makeWidget'];
    const { newViolations, staleEntries } = evaluateAgainstBaseline([violation], baseline);
    expect(newViolations).toEqual([]);
    expect(staleEntries).toEqual(['gone.test.ts :: @fixture/widget :: makeWidget']);

    const fresh = { ...violation, missingExport: 'makeWidget' };
    expect(evaluateAgainstBaseline([violation, fresh], baseline).newViolations).toEqual([fresh]);
  });

  it('a NEW file omitting an EXISTING curated export is a new violation, not grandfathered (review F3)', () => {
    // Baseline knows old.test.ts; the same module::export triple in a brand-new
    // test file must NOT be absorbed (keys are exact file::module::export).
    const baseline = ['old.test.ts :: @fixture/widget :: resetWidget'];
    const newFileViolation = {
      file: 'new.test.ts',
      modulePath: '@fixture/widget',
      missingExport: 'resetWidget',
      line: 1,
    };
    const oldFileViolation = { ...newFileViolation, file: 'old.test.ts' };
    const { newViolations, staleEntries } = evaluateAgainstBaseline(
      [oldFileViolation, newFileViolation],
      baseline,
    );
    expect(newViolations).toEqual([newFileViolation]);
    expect(staleEntries).toEqual([]);
  });
});

describe('real repo scan (non-vacuous plumbing)', () => {
  it('finds the known heavily-mocked factory population for the curated modules', () => {
    const outcome = scanRepo();
    // 93 factories measured at Stage-10 time (82 errorReporter + 11
    // captureKnownCondition); assert a loose floor so the test doesn't churn.
    expect(outcome.curatedFactories).toBeGreaterThanOrEqual(50);
    expect(outcome.scannedFiles).toBeGreaterThanOrEqual(100);
    expect(MOCK_CONTRACT_REGISTRY.length).toBe(2);
  });
});
