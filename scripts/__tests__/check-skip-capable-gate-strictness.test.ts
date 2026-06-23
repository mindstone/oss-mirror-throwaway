/**
 * SKIP-capable gate strictness meta-gate tests.
 *
 * The validate:fast step `check-skip-capable-gate-strictness` enforces that
 * every SKIP-capable gate wired into validate:fast is declared in
 * scripts/skip-capable-gate-manifest.ts as either a strict CI leg (REQUIRE_*=1
 * env verified present in its workflow) or an explicit exclusion with an honest
 * reason — see docs/plans/260611_fix-mcp-equivalence-gate/PLAN.md Stage 4 and the
 * postmortem docs-private/postmortems/260612_inert_atomic_helper_equivalence_gate_postmortem.md.
 *
 * These tests pin (a) the current repo state passing, (b) the detector matching
 * the real SKIP idiom and NOT incidental directory-walk constants, and (c) each
 * failure mode firing — undeclared SKIP-capable script, stale manifest entry,
 * blank exclusion reason, strict-env-absent-from-workflow — via the checker's
 * exported pure function with an in-memory (fixture) file reader.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SELF_SCRIPTS,
  checkSkipCapableGateStrictness,
  isSkipCapable,
  resolveValidateFastScripts,
  strictEnvWiredInWorkflow,
  type MetaGateInputs,
} from '../check-skip-capable-gate-strictness';
import { STEPS } from '../run-validate-fast';
import {
  EXCLUDED_SKIP_CAPABLE_GATES,
  STRICT_SKIP_CAPABLE_GATES,
} from '../skip-capable-gate-manifest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A skip-capable script source (matches the advisory idiom). */
const SKIPPY_SRC = `console.log('⏭️  resources/foo not found — skipping');\nprocess.exit(0);`;
/** A discriminated status-skip source (the atomic-helper shape). */
const STATUS_SKIP_SRC = `return { status: 'skip', message: msg };`;
/** A NON-skip-capable source: only directory-walk skip constants. */
const WALK_ONLY_SRC = `const SKIP_DIRS = new Set(['node_modules', 'dist']);\nif (SKIP_DIRS.has(name)) continue;`;
const WORKFLOW_WITH_ENV = `        env:\n          REQUIRE_MCP_OSS_EQUIVALENCE: '1'\n`;
const WORKFLOW_WITHOUT_ENV = `        run: npm run validate:fast\n`;

/** Build a fixture readFile from a {relPath: contents} map (null = missing). */
function fixtureReader(files: Record<string, string>): MetaGateInputs['readFile'] {
  return (relPath) => (relPath in files ? files[relPath] : null);
}

describe('isSkipCapable detector', () => {
  it('matches the SKIP advisory idiom (⏭ + skipping, console SKIP, skip:)', () => {
    expect(isSkipCapable(SKIPPY_SRC)).toBe(true);
    expect(isSkipCapable(`console.warn('⚠️ SKIP: not found');`)).toBe(true);
    expect(isSkipCapable(`console.log('[x] skip: no relevant change');`)).toBe(true);
  });

  it('matches a discriminated status: "skip" result', () => {
    expect(isSkipCapable(STATUS_SKIP_SRC)).toBe(true);
  });

  it('does NOT match incidental directory-walk skip constants', () => {
    expect(isSkipCapable(WALK_ONLY_SRC)).toBe(false);
    expect(isSkipCapable(`const WALK_SKIP_DIRECTORIES = new Set(['.git']);`)).toBe(false);
    // A summary count mentioning "(skipped)" is reporting, not a gate skip.
    expect(isSkipCapable('console.log(`Allowlisted (skipped):   ${n}`);')).toBe(false);
  });

  // Phase 6 review F1 regression: the three REAL validate:fast idioms the
  // callee-anchored v1 detector missed. Snippets are verbatim from the scripts.
  it('matches check-renderer-bundle-singletons: lowercase "skipping" in a template-literal advisory', () => {
    const snippet =
      'console.log(\n' +
      '  `⚠ [renderer-bundle-singletons] ADVISORY: no built renderer bundle at ${bundleDir}; skipping. ` +\n' +
      "    'This check has teeth only after `npm run package` (release pipeline, run with ' +\n" +
      '    `${ENV_ENFORCE}=1 / --enforce). Skipping cleanly (exit 0).`,\n' +
      ');\nreturn;';
    expect(isSkipCapable(snippet)).toBe(true);
  });

  it('matches check-worker-build-smoke: injected log() + WORKER_BUILD_SMOKE=skip value comparison', () => {
    const injectedLog = `log('[worker-build-smoke] skip: WORKER_BUILD_SMOKE requested force-skip');\nreturn 0;`;
    expect(isSkipCapable(injectedLog)).toBe(true);
    const valueSkip = `const mode = env.WORKER_BUILD_SMOKE?.trim().toLowerCase();\nif (mode === '0' || mode === 'false' || mode === 'skip') {\n  return 0;\n}`;
    expect(isSkipCapable(valueSkip)).toBe(true);
  });

  it('matches check-cross-surface-parity-gap: SKIP_* env bypass via streams.stderr.write', () => {
    const snippet =
      "if (env.SKIP_CROSS_SURFACE_PARITY_GAP === '1') {\n" +
      '  streams.stderr.write(\n' +
      '    `${WARNING_PREFIX} SKIP_CROSS_SURFACE_PARITY_GAP=1 set; gate bypassed.\\n`,\n' +
      '  );\n  return 0;\n}';
    expect(isSkipCapable(snippet)).toBe(true);
    // The env-bypass pattern alone (no advisory literal) is sufficient.
    expect(isSkipCapable(`if (process.env.SKIP_MY_GATE === '1') return 0;`)).toBe(true);
  });
});

describe('strictEnvWiredInWorkflow (F3: non-comment wiring, not raw substring)', () => {
  it('accepts a YAML mapping key and an inline assignment', () => {
    expect(strictEnvWiredInWorkflow(`        env:\n          REQUIRE_X: '1'\n`, 'REQUIRE_X')).toBe(true);
    expect(strictEnvWiredInWorkflow(`        run: REQUIRE_X=1 npm run validate:fast\n`, 'REQUIRE_X')).toBe(true);
  });

  it('rejects a comment-only mention (the stale-green shape)', () => {
    const commentOnly = `        # runs strict here via REQUIRE_X=1 on the validate step\n        run: npm run validate:fast\n`;
    expect(strictEnvWiredInWorkflow(commentOnly, 'REQUIRE_X')).toBe(false);
  });

  it('rejects absence entirely', () => {
    expect(strictEnvWiredInWorkflow(`        run: npm run validate:fast\n`, 'REQUIRE_X')).toBe(false);
  });
});

describe('resolveValidateFastScripts', () => {
  it('extracts scripts from direct tsx steps and npm-run lookups', () => {
    const scripts = resolveValidateFastScripts(
      [
        { command: 'npx tsx scripts/check-foo.ts' },
        { command: 'npm run validate:bar' },
        { command: 'npx vitest run tests/parity' }, // no scripts/*.ts → ignored
      ],
      { 'validate:bar': 'npx tsx scripts/check-bar.ts' },
    );
    expect(scripts).toEqual(['scripts/check-bar.ts', 'scripts/check-foo.ts']);
  });
});

describe('check-skip-capable-gate-strictness', () => {
  it('passes on the current repo state (real STEPS + manifest + workflows)', () => {
    const pkgScripts = (
      JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts ?? {};
    const validateFastScripts = resolveValidateFastScripts(STEPS, pkgScripts);
    expect(validateFastScripts.length).toBeGreaterThan(0);

    const errors = checkSkipCapableGateStrictness({
      validateFastScripts,
      readFile: (relPath) => {
        try {
          return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
        } catch {
          return null;
        }
      },
      strict: STRICT_SKIP_CAPABLE_GATES,
      excluded: EXCLUDED_SKIP_CAPABLE_GATES,
      selfScripts: SELF_SCRIPTS,
    });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('does not scan or require declaration of the meta-gate own script/manifest (self-exclusion)', () => {
    // Both self-scripts match the SKIP detector (advisory strings + the
    // status:'skip' regex literal) yet must NOT be flagged as undeclared.
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: [
        'scripts/check-skip-capable-gate-strictness.ts',
        'scripts/skip-capable-gate-manifest.ts',
      ],
      readFile: fixtureReader({
        'scripts/check-skip-capable-gate-strictness.ts': SKIPPY_SRC,
        'scripts/skip-capable-gate-manifest.ts': STATUS_SKIP_SRC,
      }),
      strict: [],
      excluded: [],
      selfScripts: SELF_SCRIPTS,
    });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('passes a minimal verified strict entry whose env is present in the workflow', () => {
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: ['scripts/check-thing.ts'],
      readFile: fixtureReader({
        'scripts/check-thing.ts': SKIPPY_SRC,
        '.github/workflows/ci.yml': WORKFLOW_WITH_ENV,
      }),
      strict: [
        {
          script: 'scripts/check-thing.ts',
          strictEnv: 'REQUIRE_MCP_OSS_EQUIVALENCE',
          ciLocation: '.github/workflows/ci.yml',
          note: 'Skips locally; strict in CI via the env flag set on the validate step.',
        },
      ],
      excluded: [],
    });
    expect(errors).toEqual([]);
  });

  it('fails (undeclared) when a SKIP-capable validate:fast script is missing from the manifest', () => {
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: ['scripts/check-new-gate.ts'],
      readFile: fixtureReader({ 'scripts/check-new-gate.ts': SKIPPY_SRC }),
      strict: [],
      excluded: [],
    });
    const err = errors.find((e) => e.includes('scripts/check-new-gate.ts'));
    expect(err, errors.join('\n')).toBeDefined();
    expect(err).toContain('not declared');
    expect(err).toContain('skip-capable-gate-manifest.ts');
  });

  it('does NOT flag a non-SKIP-capable validate:fast script', () => {
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: ['scripts/check-walk-only.ts'],
      readFile: fixtureReader({ 'scripts/check-walk-only.ts': WALK_ONLY_SRC }),
      strict: [],
      excluded: [],
    });
    expect(errors).toEqual([]);
  });

  it('fails (stale) when a manifest entry no longer matches the SKIP pattern', () => {
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: ['scripts/check-thing.ts'],
      readFile: fixtureReader({ 'scripts/check-thing.ts': WALK_ONLY_SRC }),
      strict: [],
      excluded: [
        {
          script: 'scripts/check-thing.ts',
          reason: 'this reason is long enough to pass the minimum-length floor easily',
        },
      ],
    });
    const err = errors.find((e) => e.includes('scripts/check-thing.ts'));
    expect(err, errors.join('\n')).toBeDefined();
    expect(err).toContain('no longer matches the SKIP pattern');
  });

  it('fails (stale) when a manifest entry points at a non-existent file', () => {
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: [],
      readFile: fixtureReader({}),
      strict: [],
      excluded: [
        {
          script: 'scripts/check-deleted.ts',
          reason: 'a perfectly long and well-documented reason for the test fixture',
        },
      ],
    });
    const err = errors.find((e) => e.includes('scripts/check-deleted.ts'));
    expect(err, errors.join('\n')).toBeDefined();
    expect(err).toContain('no such file exists');
  });

  it('fails when an exclusion reason is blank or trivial', () => {
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: ['scripts/check-thing.ts'],
      readFile: fixtureReader({ 'scripts/check-thing.ts': SKIPPY_SRC }),
      strict: [],
      excluded: [{ script: 'scripts/check-thing.ts', reason: 'too short' }],
    });
    const err = errors.find((e) => e.includes('blank or trivial reason'));
    expect(err, errors.join('\n')).toBeDefined();
  });

  it('fails when a strict entry names an env var absent from its workflow', () => {
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: ['scripts/check-thing.ts'],
      readFile: fixtureReader({
        'scripts/check-thing.ts': SKIPPY_SRC,
        '.github/workflows/ci.yml': WORKFLOW_WITHOUT_ENV,
      }),
      strict: [
        {
          script: 'scripts/check-thing.ts',
          strictEnv: 'REQUIRE_MCP_OSS_EQUIVALENCE',
          ciLocation: '.github/workflows/ci.yml',
          note: 'Claims a strict leg the workflow does not actually wire.',
        },
      ],
      excluded: [],
    });
    const err = errors.find((e) => e.includes('is not wired there'));
    expect(err, errors.join('\n')).toBeDefined();
    expect(err).toContain('REQUIRE_MCP_OSS_EQUIVALENCE');
  });

  it('fails when a strict entry names a non-existent workflow file', () => {
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: ['scripts/check-thing.ts'],
      readFile: fixtureReader({ 'scripts/check-thing.ts': SKIPPY_SRC }),
      strict: [
        {
          script: 'scripts/check-thing.ts',
          strictEnv: 'REQUIRE_X',
          ciLocation: '.github/workflows/missing.yml',
          note: 'Workflow path is wrong.',
        },
      ],
      excluded: [],
    });
    const err = errors.find((e) => e.includes('.github/workflows/missing.yml'));
    expect(err, errors.join('\n')).toBeDefined();
    expect(err).toContain('does not exist');
  });

  it('fails when a script is declared in both STRICT and EXCLUDED', () => {
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: ['scripts/check-thing.ts'],
      readFile: fixtureReader({
        'scripts/check-thing.ts': SKIPPY_SRC,
        '.github/workflows/ci.yml': WORKFLOW_WITH_ENV,
      }),
      strict: [
        {
          script: 'scripts/check-thing.ts',
          strictEnv: 'REQUIRE_MCP_OSS_EQUIVALENCE',
          ciLocation: '.github/workflows/ci.yml',
          note: 'strict and also excluded — contradiction',
        },
      ],
      excluded: [
        {
          script: 'scripts/check-thing.ts',
          reason: 'a long enough reason to clear the floor but it contradicts the strict entry',
        },
      ],
    });
    const err = errors.find((e) => e.includes('both STRICT and EXCLUDED'));
    expect(err, errors.join('\n')).toBeDefined();
  });

  it('rejects a self-script declared in EXCLUDED (F2 — mirrors the STRICT rejection)', () => {
    const self = 'scripts/check-skip-capable-gate-strictness.ts';
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: [self],
      readFile: fixtureReader({ [self]: SKIPPY_SRC }),
      strict: [],
      excluded: [
        {
          script: self,
          reason: 'a long, persuasive — but invalid — reason: self-scripts are filtered by construction',
        },
      ],
      selfScripts: SELF_SCRIPTS,
    });
    const err = errors.find((e) => e.includes("meta-gate's own script"));
    expect(err, errors.join('\n')).toBeDefined();
  });

  it('fails (stale) when a declared entry is no longer wired into validate:fast (F4)', () => {
    // Script exists on disk and still matches the SKIP pattern, but was dropped
    // from the STEPS list — the manifest entry is dead config and must go.
    const errors = checkSkipCapableGateStrictness({
      validateFastScripts: [], // not wired
      readFile: fixtureReader({ 'scripts/check-unwired.ts': SKIPPY_SRC }),
      strict: [],
      excluded: [
        {
          script: 'scripts/check-unwired.ts',
          reason: 'long enough reason for the fixture; the entry is stale for wiring, not wording',
        },
      ],
    });
    const err = errors.find((e) => e.includes('not wired into validate:fast'));
    expect(err, errors.join('\n')).toBeDefined();
    expect(err).toContain('scripts/check-unwired.ts');
  });

  it('manifest: the mandatory atomic-helper entry is strict and verified', () => {
    const entry = STRICT_SKIP_CAPABLE_GATES.find(
      (e) => e.script === 'scripts/check-atomic-helper-equivalence.ts',
    );
    expect(entry).toBeDefined();
    expect(entry!.strictEnv).toBe('REQUIRE_MCP_OSS_EQUIVALENCE');
    expect(entry!.ciLocation).toBe('.github/workflows/reusable-validation.yml');
  });
});
