import { describe, expect, it } from 'vitest';
import {
  extractImportedModuleStems,
  findContractCoverageViolations,
  isDiscoverableTestPath,
  isEnforcing,
  MIN_WAIVER_LENGTH,
  parseOwnedByModules,
  parseRegistryEntries,
  resolveImportSpecifierToStem,
  runCli,
  testImportsOwnedModule,
  validateWaiver,
  type CliIo,
  type FsLike,
  type RegistryEntry,
} from '../check-boundary-contract-coverage';

/** Build an in-memory FsLike from a path → contents map. */
function fakeFs(files: Record<string, string>): FsLike {
  return {
    readFile: (p) => (p in files ? files[p] : null),
    exists: (p) => p in files,
  };
}

const OWNER = 'src/core/rebelCore/providerRouting.ts';
const TEST = 'src/core/rebelCore/__tests__/providerRouting.invariants.test.ts';
const TEST_SRC_IMPORTS_OWNER = `import { ProviderRouter } from '../providerRouting';\n`;
const TEST_SRC_NO_OWNER = `import { somethingElse } from '../planningMode';\n`;

describe('validateWaiver', () => {
  it('accepts a >=30-char concrete reason', () => {
    expect(validateWaiver('Brand-typed kill-by-construction; the compiler rejects the unsafe path entirely.')).toEqual({
      valid: true,
    });
  });
  it('rejects a too-short reason', () => {
    const v = validateWaiver('too short');
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.explanation).toContain(`minimum ${MIN_WAIVER_LENGTH}`);
  });
  it('rejects a weak-marker reason even if long enough', () => {
    const v = validateWaiver('TODO add a real contract test for this seam eventually when there is time');
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.explanation).toContain('TODO');
  });
});

describe('parseOwnedByModules', () => {
  it('splits ` + `-joined owners and trims', () => {
    expect(parseOwnedByModules('a/b.ts + c/d.ts')).toEqual(['a/b.ts', 'c/d.ts']);
  });
  it('returns [] for undefined', () => {
    expect(parseOwnedByModules(undefined)).toEqual([]);
  });
});

describe('isDiscoverableTestPath', () => {
  it('accepts *.test.ts / *.spec.tsx basenames', () => {
    expect(isDiscoverableTestPath('src/foo/__tests__/bar.test.ts')).toBe(true);
    expect(isDiscoverableTestPath('tests/parity/x.spec.tsx')).toBe(true);
  });
  it('rejects a non-test source path', () => {
    expect(isDiscoverableTestPath('src/foo/bar.ts')).toBe(false);
  });
  it('F1: rejects a non-test file even when it lives under __tests__/ (helper false-pass)', () => {
    expect(isDiscoverableTestPath('src/foo/__tests__/helper.ts')).toBe(false);
    expect(isDiscoverableTestPath('tests/parity/fixtures.ts')).toBe(false);
  });
});

describe('parseOwnedByModules', () => {
  it('does NOT split on a `+` inside a path (only the ` + ` join convention)', () => {
    expect(parseOwnedByModules('src/foo/a+b.ts')).toEqual(['src/foo/a+b.ts']);
    expect(parseOwnedByModules('src/a.ts + src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('extractImportedModuleStems / testImportsOwnedModule (TS-AST + aliases)', () => {
  it('resolves a relative import against the test dir', () => {
    const stems = extractImportedModuleStems(TEST, TEST_SRC_IMPORTS_OWNER);
    expect(stems.has('src/core/rebelCore/providerRouting')).toBe(true);
  });
  it('matches the owned module by stem', () => {
    expect(testImportsOwnedModule(TEST, TEST_SRC_IMPORTS_OWNER, [OWNER])).toBe(true);
  });
  it('returns false when no owned module is imported', () => {
    expect(testImportsOwnedModule(TEST, TEST_SRC_NO_OWNER, [OWNER])).toBe(false);
  });
  it('is satisfied if ANY of several owners is imported', () => {
    expect(testImportsOwnedModule(TEST, TEST_SRC_IMPORTS_OWNER, ['x/y.ts', OWNER])).toBe(true);
  });

  it('F2: a COMMENTED-OUT import does NOT satisfy the floor', () => {
    const src = `// import { ProviderRouter } from '../providerRouting';\nimport { x } from '../planningMode';\n`;
    expect(testImportsOwnedModule(TEST, src, [OWNER])).toBe(false);
  });
  it('F2: a block-commented import does NOT satisfy the floor', () => {
    const src = `/* import { ProviderRouter } from '../providerRouting'; */\nconst y = 1;\n`;
    expect(testImportsOwnedModule(TEST, src, [OWNER])).toBe(false);
  });
  it('F2: the specifier only inside a STRING LITERAL does NOT satisfy the floor', () => {
    const src = `const note = "see import from '../providerRouting' for details";\n`;
    expect(testImportsOwnedModule(TEST, src, [OWNER])).toBe(false);
  });
  it('F2: a real dynamic import() DOES satisfy the floor', () => {
    const src = `const m = await import('../providerRouting');\n`;
    expect(testImportsOwnedModule(TEST, src, [OWNER])).toBe(true);
  });
  it('F2: a real require() DOES satisfy the floor', () => {
    const src = `const m = require('../providerRouting');\n`;
    expect(testImportsOwnedModule(TEST, src, [OWNER])).toBe(true);
  });

  it('F4: an ALIAS import (@core/...) satisfies the floor', () => {
    const src = `import { ProviderRouter } from '@core/rebelCore/providerRouting';\n`;
    expect(testImportsOwnedModule(TEST, src, [OWNER])).toBe(true);
  });
  it('F4: alias maps resolve to the same stem as a relative import', () => {
    expect(resolveImportSpecifierToStem(TEST, '@core/rebelCore/providerRouting')).toBe(
      'src/core/rebelCore/providerRouting',
    );
    expect(resolveImportSpecifierToStem(TEST, '@rebel/shared/utils/x')).toBe('packages/shared/src/utils/x');
    expect(resolveImportSpecifierToStem(TEST, '../providerRouting')).toBe('src/core/rebelCore/providerRouting');
  });
  it('F4: a bare/package specifier resolves to null (cannot be a repo owner)', () => {
    expect(resolveImportSpecifierToStem(TEST, 'vitest')).toBeNull();
    expect(resolveImportSpecifierToStem(TEST, 'node:fs')).toBeNull();
  });
});

describe('findContractCoverageViolations', () => {
  it('OK: declared + present + imports owned module', () => {
    const entries: RegistryEntry[] = [{ id: 'e1', owned_by: OWNER, contract_test: [TEST] }];
    const report = findContractCoverageViolations({
      fs: fakeFs({ [TEST]: TEST_SRC_IMPORTS_OWNER }),
      entries,
    });
    expect(report.violations).toEqual([]);
    expect(report.checkedEntryIds).toEqual(['e1']);
  });

  it('ignores entries that do NOT declare contract_test (opt-in only)', () => {
    const entries: RegistryEntry[] = [{ id: 'untested', owned_by: OWNER }];
    const report = findContractCoverageViolations({ fs: fakeFs({}), entries });
    expect(report.violations).toEqual([]);
    expect(report.checkedEntryIds).toEqual([]);
  });

  it('violation (orphan): declared file does not exist', () => {
    const entries: RegistryEntry[] = [{ id: 'e1', owned_by: OWNER, contract_test: [TEST] }];
    const report = findContractCoverageViolations({ fs: fakeFs({}), entries });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].kind).toBe('orphan');
  });

  it('violation (import-floor): present but does NOT import owned module', () => {
    const entries: RegistryEntry[] = [{ id: 'e1', owned_by: OWNER, contract_test: [TEST] }];
    const report = findContractCoverageViolations({
      fs: fakeFs({ [TEST]: TEST_SRC_NO_OWNER }),
      entries,
    });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].kind).toBe('import-floor');
  });

  it('violation (not-discoverable): present, imports owner, but not a test-glob path', () => {
    const badPath = 'src/core/rebelCore/providerRouting.ts'; // not a *.test.ts
    const entries: RegistryEntry[] = [{ id: 'e1', owned_by: OWNER, contract_test: [badPath] }];
    const report = findContractCoverageViolations({
      fs: fakeFs({ [badPath]: TEST_SRC_IMPORTS_OWNER }),
      entries,
    });
    expect(report.violations.some((v) => v.kind === 'not-discoverable')).toBe(true);
  });

  it('floor SKIPPED when owned_by is absent (only existence + discoverability checked)', () => {
    const entries: RegistryEntry[] = [{ id: 'e1', contract_test: [TEST] }];
    const report = findContractCoverageViolations({
      fs: fakeFs({ [TEST]: TEST_SRC_NO_OWNER }),
      entries,
    });
    expect(report.violations).toEqual([]);
    expect(report.floorSkippedEntryIds).toEqual(['e1']);
  });

  it('waiver-ONLY entry (valid waiver, no contract_test) is waived, no runtime checks', () => {
    const entries: RegistryEntry[] = [
      {
        id: 'e1',
        owned_by: OWNER,
        contract_test_waiver: 'Brand-typed kill-by-construction; the compiler rejects the unsafe path entirely.',
      },
    ];
    const report = findContractCoverageViolations({ fs: fakeFs({}), entries });
    expect(report.violations).toEqual([]);
    expect(report.waivedEntryIds).toEqual(['e1']);
  });

  it('waiver-ONLY entry with a weak waiver → bad-waiver violation', () => {
    const entries: RegistryEntry[] = [{ id: 'e1', contract_test_waiver: 'TODO later add a test for this seam' }];
    const report = findContractCoverageViolations({ fs: fakeFs({}), entries });
    expect(report.violations.some((v) => v.kind === 'bad-waiver')).toBe(true);
    expect(report.waivedEntryIds).toEqual([]);
  });

  it('F5: declaring BOTH contract_test and a (valid) waiver is a bad-schema config error', () => {
    const entries: RegistryEntry[] = [
      {
        id: 'e1',
        owned_by: OWNER,
        contract_test: [TEST],
        contract_test_waiver: 'Brand-typed kill-by-construction; the compiler rejects the unsafe path entirely.',
      },
    ];
    const report = findContractCoverageViolations({ fs: fakeFs({ [TEST]: TEST_SRC_IMPORTS_OWNER }), entries });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].kind).toBe('bad-schema');
    // NOT suppressed/waived — the both-declared rule fires regardless of waiver validity.
    expect(report.waivedEntryIds).toEqual([]);
  });

  it('F3: a schemaErrors entry surfaces a bad-schema violation (not silently dropped)', () => {
    const entries: RegistryEntry[] = [
      { id: 'e1', schemaErrors: ['contract_test must be a non-empty array of strings (got string)'] },
    ];
    const report = findContractCoverageViolations({ fs: fakeFs({}), entries });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].kind).toBe('bad-schema');
    expect(report.checkedEntryIds).toEqual(['e1']);
  });
});

describe('parseRegistryEntries', () => {
  it('parses contract_test and contract_test_waiver, ignoring unknown keys', () => {
    const yaml = `
version: 1
boundaries:
  - id: e1
    owned_by: ${OWNER}
    contract_test:
      - ${TEST}
    contract_test_waiver: some reason text long enough to be valid here
    some_unknown_future_key: ignored
  - id: e2
`;
    const entries = parseRegistryEntries(yaml);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: 'e1', owned_by: OWNER, contract_test: [TEST] });
    expect(entries[1].contract_test).toBeUndefined();
  });
  it('throws on a registry with no boundaries array', () => {
    expect(() => parseRegistryEntries('version: 1')).toThrow();
  });

  it('F3: contract_test as a SCALAR records a schema error (not silently dropped)', () => {
    const entries = parseRegistryEntries(`version: 1\nboundaries:\n  - id: e1\n    contract_test: ${TEST}\n`);
    expect(entries[0].contract_test).toBeUndefined();
    expect(entries[0].schemaErrors?.some((e) => e.includes('non-empty array'))).toBe(true);
  });

  it('F3: contract_test as an EMPTY array records a schema error', () => {
    const entries = parseRegistryEntries(`version: 1\nboundaries:\n  - id: e1\n    contract_test: []\n`);
    expect(entries[0].schemaErrors?.some((e) => e.includes('empty array'))).toBe(true);
  });

  it('F3: contract_test with a MIXED non-string element records a schema error', () => {
    const yaml = `version: 1\nboundaries:\n  - id: e1\n    contract_test:\n      - ${TEST}\n      - 42\n`;
    const entries = parseRegistryEntries(yaml);
    expect(entries[0].contract_test).toBeUndefined();
    expect(entries[0].schemaErrors?.some((e) => e.includes('only string paths'))).toBe(true);
  });

  it('F3: NON-STRING owned_by with contract_test present records a schema error (not a silent floor-skip)', () => {
    const yaml = `version: 1\nboundaries:\n  - id: e1\n    owned_by: [a, b]\n    contract_test:\n      - ${TEST}\n`;
    const entries = parseRegistryEntries(yaml);
    expect(entries[0].owned_by).toBeUndefined();
    expect(entries[0].schemaErrors?.some((e) => e.includes('owned_by must be a string'))).toBe(true);
  });

  it('F3: NON-STRING waiver records a schema error', () => {
    const yaml = `version: 1\nboundaries:\n  - id: e1\n    contract_test_waiver: 123\n`;
    const entries = parseRegistryEntries(yaml);
    expect(entries[0].contract_test_waiver).toBeUndefined();
    expect(entries[0].schemaErrors?.some((e) => e.includes('contract_test_waiver must be a string'))).toBe(true);
  });
});

describe('isEnforcing', () => {
  it('true for --enforce', () => {
    expect(isEnforcing(['--enforce'])).toBe(true);
  });
  it('false by default with no flag/env', () => {
    const prev = process.env.BOUNDARY_CONTRACT_COVERAGE_ENFORCE;
    delete process.env.BOUNDARY_CONTRACT_COVERAGE_ENFORCE;
    try {
      expect(isEnforcing([])).toBe(false);
    } finally {
      if (prev !== undefined) process.env.BOUNDARY_CONTRACT_COVERAGE_ENFORCE = prev;
    }
  });
});

describe('runCli exit codes', () => {
  const captureIo = (): CliIo & { lines: string[] } => {
    const lines: string[] = [];
    return {
      lines,
      log: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    };
  };
  const registryYaml = (entry: string): string => `version: 1\nboundaries:\n${entry}`;
  const ORPHAN_ENTRY = `  - id: e1\n    owned_by: ${OWNER}\n    contract_test:\n      - ${TEST}\n`;

  it('warn mode: violations present but returns 0 (does not fail the build)', () => {
    const io = captureIo();
    const code = runCli({
      argv: [],
      fs: fakeFs({}), // TEST missing → orphan violation
      registryText: registryYaml(ORPHAN_ENTRY),
      io,
    });
    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('ADVISORY');
  });

  it('enforce mode: same violations return 1', () => {
    const io = captureIo();
    const code = runCli({
      argv: ['--enforce'],
      fs: fakeFs({}),
      registryText: registryYaml(ORPHAN_ENTRY),
      io,
    });
    expect(code).toBe(1);
    expect(io.lines.join('\n')).toContain('FAIL');
  });

  it('clean registry returns 0 in both modes', () => {
    const ok = `  - id: e1\n    owned_by: ${OWNER}\n    contract_test:\n      - ${TEST}\n`;
    const fs = fakeFs({ [TEST]: TEST_SRC_IMPORTS_OWNER });
    expect(runCli({ argv: [], fs, registryText: registryYaml(ok), io: captureIo() })).toBe(0);
    expect(runCli({ argv: ['--enforce'], fs, registryText: registryYaml(ok), io: captureIo() })).toBe(0);
  });

  it('unparseable registry: warn mode returns 0, enforce returns 1', () => {
    expect(runCli({ argv: [], fs: fakeFs({}), registryText: 'version: 1', io: captureIo() })).toBe(0);
    expect(runCli({ argv: ['--enforce'], fs: fakeFs({}), registryText: 'version: 1', io: captureIo() })).toBe(1);
  });

  it('F3: warn mode still returns 0 with a BAD-SCHEMA violation (scalar contract_test)', () => {
    const io = captureIo();
    const badSchema = `  - id: e1\n    contract_test: ${TEST}\n`; // scalar, not array
    const code = runCli({ argv: [], fs: fakeFs({}), registryText: registryYaml(badSchema), io });
    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('ADVISORY');
  });

  it('F3: enforce mode returns 1 on a BAD-SCHEMA violation', () => {
    const badSchema = `  - id: e1\n    contract_test: ${TEST}\n`;
    expect(
      runCli({ argv: ['--enforce'], fs: fakeFs({}), registryText: registryYaml(badSchema), io: captureIo() }),
    ).toBe(1);
  });

  it('enforce via BOUNDARY_CONTRACT_COVERAGE_ENFORCE env (not just --enforce) returns 1', () => {
    const prev = process.env.BOUNDARY_CONTRACT_COVERAGE_ENFORCE;
    process.env.BOUNDARY_CONTRACT_COVERAGE_ENFORCE = '1';
    try {
      const code = runCli({ argv: [], fs: fakeFs({}), registryText: registryYaml(ORPHAN_ENTRY), io: captureIo() });
      expect(code).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.BOUNDARY_CONTRACT_COVERAGE_ENFORCE;
      else process.env.BOUNDARY_CONTRACT_COVERAGE_ENFORCE = prev;
    }
  });
});
