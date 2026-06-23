/**
 * Stage 1 of 260505_typed_provider_capability_matrix: durable lint regression
 * fixtures for the providerFeatureGate rule.
 *
 * Shells out to ESLint over the negative fixtures in
 * `src/core/rebelCore/__lint_fixtures__/providerFeatureGate/` and asserts the
 * positive fixtures produce at least one `no-restricted-syntax` error and the
 * acknowledged-hole fixture stays clean. Closes the regression vector where a
 * future config edit silently disables the ban for one shape.
 *
 * Note: the fixtures live under `src/core/rebelCore/__lint_fixtures__/`, which
 * the rule's per-file-scope blocks DON'T match — so the runner uses
 * `--rule no-restricted-syntax: <selectors>` overrides? No: instead, we verify
 * by importing the fixtures into a temp file at one of the in-scope paths and
 * running ESLint against that. To keep the test simple, the fixtures are
 * placed at `src/core/rebelCore/clients/__lint_fixtures__/providerFeatureGate/`
 * — but flat config's `ignores` covers that path. So the runner uses
 * `--no-ignore` AND the fixtures are at a path that the per-file-scope blocks
 * DO match. The simplest stable approach: put fixtures inside the
 * client-scoped directory (`src/core/rebelCore/clients/__lint_fixtures__/...`)
 * OR explicitly add the fixture path to a dedicated rule block in
 * `eslint.config.mjs`. We use the dedicated-block approach: fixtures live at
 * `src/core/rebelCore/__lint_fixtures__/providerFeatureGate/` and the test
 * uses `--rule` to inject the providerFeatureGate selectors.
 *
 * These tests are slow (spawn the ESLint CLI). Bounded fixture count keeps
 * the wall-clock cost acceptable.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  'src',
  'core',
  'rebelCore',
  '__lint_fixtures__',
  'providerFeatureGate',
);

interface EslintFileReport {
  filePath: string;
  messages: Array<{ ruleId: string | null; message: string; severity: number }>;
  errorCount: number;
}

const PROVIDER_FEATURE_GATE_RULE_CONFIG = JSON.stringify([
  'error',
  {
    selector:
      "BinaryExpression[operator='==='][left.property.name='providerType'][right.type='Literal']",
    message: 'providerFeatureGate equality violation',
  },
  {
    selector:
      "BinaryExpression[operator='!=='][left.property.name='providerType'][right.type='Literal']",
    message: 'providerFeatureGate negation violation',
  },
  {
    selector:
      "BinaryExpression[operator='==='][left.property.name='kind'][right.type='Literal']",
    message: 'providerFeatureGate kind equality violation',
  },
  {
    selector:
      "BinaryExpression[operator='!=='][left.property.name='kind'][right.type='Literal']",
    message: 'providerFeatureGate kind negation violation',
  },
  {
    selector: "SwitchStatement[discriminant.property.name='providerType']",
    message: 'providerFeatureGate switch violation',
  },
  {
    selector: "SwitchStatement[discriminant.property.name='kind']",
    message: 'providerFeatureGate kind switch violation',
  },
  {
    selector:
      "CallExpression[callee.property.name='has'] > MemberExpression[property.name='providerType']",
    message: 'providerFeatureGate Set.has violation',
  },
  {
    selector:
      "CallExpression[callee.property.name='has'][arguments.0.type='Identifier'][arguments.0.name='providerType']",
    message: 'providerFeatureGate Set.has bare-identifier violation',
  },
  {
    selector:
      "CallExpression[callee.property.name='includes'] > MemberExpression[property.name='providerType']",
    message: 'providerFeatureGate Array.includes violation',
  },
  {
    selector:
      "CallExpression[callee.property.name='includes'][arguments.0.type='Identifier'][arguments.0.name='providerType']",
    message: 'providerFeatureGate Array.includes bare-identifier violation',
  },
]);

function lintFixture(absPath: string): EslintFileReport {
  let stdout = '';
  try {
    stdout = execFileSync(
      'npx',
      [
        'eslint',
        '--format',
        'json',
        '--no-ignore',
        '--rule',
        `no-restricted-syntax: ${PROVIDER_FEATURE_GATE_RULE_CONFIG}`,
        absPath,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const e = err as { stdout?: Buffer | string };
    stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? '');
  }
  const reports = JSON.parse(stdout) as EslintFileReport[];
  const report = reports.find(r => path.resolve(r.filePath) === path.resolve(absPath));
  if (!report) {
    throw new Error(`ESLint produced no report for ${absPath}; stdout=${stdout.slice(0, 500)}`);
  }
  return report;
}

function expectProviderFeatureGateBanFires(fixturePath: string): void {
  const report = lintFixture(fixturePath);
  const matches = report.messages.filter(m => m.ruleId === 'no-restricted-syntax');
  expect(matches.length).toBeGreaterThan(0);
}

function expectProviderFeatureGateBanDoesNotFire(fixturePath: string): void {
  const report = lintFixture(fixturePath);
  const matches = report.messages.filter(m => m.ruleId === 'no-restricted-syntax');
  expect(matches).toEqual([]);
}

describe('providerFeatureGate ESLint rule — negative lint fixtures', () => {
  it('flags `<obj>.providerType === "<literal>"`', () => {
    expectProviderFeatureGateBanFires(path.join(FIXTURES_DIR, 'equality_violation.fixture.ts'));
  }, 30_000);

  it('flags `<obj>.providerType !== "<literal>"`', () => {
    expectProviderFeatureGateBanFires(path.join(FIXTURES_DIR, 'negation_violation.fixture.ts'));
  }, 30_000);

  it('flags `switch (<obj>.providerType)`', () => {
    expectProviderFeatureGateBanFires(path.join(FIXTURES_DIR, 'switch_violation.fixture.ts'));
  }, 30_000);

  it('flags `someSet.has(<obj>.providerType)`', () => {
    expectProviderFeatureGateBanFires(path.join(FIXTURES_DIR, 'set_membership_violation.fixture.ts'));
  }, 30_000);

  it('flags `someSet.has(providerType)` with a bare-identifier argument', () => {
    expectProviderFeatureGateBanFires(
      path.join(FIXTURES_DIR, 'set_membership_bare_identifier_violation.fixture.ts'),
    );
  }, 30_000);

  it('flags `[…].includes(<obj>.providerType)`', () => {
    expectProviderFeatureGateBanFires(path.join(FIXTURES_DIR, 'array_membership_violation.fixture.ts'));
  }, 30_000);

  it('flags `[…].includes(providerType)` with a bare-identifier argument', () => {
    expectProviderFeatureGateBanFires(
      path.join(FIXTURES_DIR, 'array_membership_bare_identifier_violation.fixture.ts'),
    );
  }, 30_000);

  it('flags `<obj>.kind === "<literal>"`', () => {
    expectProviderFeatureGateBanFires(path.join(FIXTURES_DIR, 'kind_equality_violation.fixture.ts'));
  }, 30_000);

  it('flags `switch (<obj>.kind)`', () => {
    expectProviderFeatureGateBanFires(path.join(FIXTURES_DIR, 'kind_switch_violation.fixture.ts'));
  }, 30_000);

  it('does NOT flag bare-identifier `providerType === "<literal>"` (acknowledged hole)', () => {
    expectProviderFeatureGateBanDoesNotFire(
      path.join(FIXTURES_DIR, 'bare_identifier_acknowledged_hole.fixture.ts'),
    );
  }, 30_000);
});
