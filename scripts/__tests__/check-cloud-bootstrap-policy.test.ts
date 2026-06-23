/**
 * Unit tests for the cloud bootstrap policy gate (Stage A3).
 *
 * Verifies the AST-based gate catches the regression patterns from the
 * 2026-05-27 cloud OOM postmortem:
 *   1. Clean bootstrap → no violations.
 *   2. Bootstrap importing src/main/* (not in allowlist) → violation.
 *   3. Bootstrap calling cloudEmbeddingGenerator.warmup() at top-level → violation.
 *   4. Bootstrap dynamically `await import('@huggingface/transformers')` → violation.
 *      This is the test that proves AST > regex: regex would match the same
 *      string but couldn't differentiate "inside a lazy method body" vs
 *      "at the top of the bootstrap function". The gate keeps the dynamic-
 *      import check bootstrap-entry-only, so the same dynamic import inside
 *      a method body of another reachable module passes.
 *
 * Plus call-pattern coverage for `initializeToolIndex` / `refreshToolIndex`
 * and a sanity check that the lazy-pattern in `cloudEmbeddingGenerator.ts`
 * is NOT flagged.
 *
 * @see scripts/check-cloud-bootstrap-policy.ts
 * @see docs/project/CLOUD_BOOTSTRAP_POLICY.md
 * @see docs-private/postmortems/260527_cloud_oom_warmup_4gb_postmortem.md
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import {
  collectImportSpecifiers,
  DEFAULT_POLICY,
  findCloudBootstrapPolicyViolations,
  type CloudBootstrapPolicy,
  type PolicyViolation,
} from '../check-cloud-bootstrap-policy';

const BOOTSTRAP_ENTRY = DEFAULT_POLICY.bootstrapEntryPath;

function detail(violations: PolicyViolation[]): Array<{ kind: string; detail: string; line: number }> {
  return violations.map((v) => ({ kind: v.kind, detail: v.detail, line: v.line }));
}

describe('findCloudBootstrapPolicyViolations — clean bootstrap', () => {
  it('returns zero violations for a minimal clean bootstrap.ts', () => {
    const source = [
      `import path from 'node:path';`,
      `import { setStoreFactory } from '@core/storeFactory';`,
      `import { cloudBootstrapWarmup } from './services/cloudBootstrapWarmup';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  cloudBootstrapWarmup.configure({ superMcpUrl: 'http://localhost:3100' });`,
      `  cloudBootstrapWarmup.scheduleIdleTimerAndWatchdog(0);`,
      `  console.log('[bootstrap] Cloud service initialized');`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    expect(violations).toEqual([]);
  });

  it('does NOT flag the canonical lazy @huggingface/transformers import inside a method body', () => {
    // This mirrors cloud-service/src/services/cloudEmbeddingGenerator.ts:initializePipeline().
    // The import is dynamic AND inside a method body — exactly the pattern the gate is
    // protecting. When the gate runs in non-bootstrap-entry mode (i.e. the file is in the
    // reachable set but is not bootstrap.ts), dynamic imports must be allowed; the gate
    // here passes the file path of a non-bootstrap reachable module so we exercise that
    // branch via the runner-level config (the test below covers the synthetic per-file call).
    const source = [
      `export class CloudEmbeddingGenerator {`,
      `  async initializePipeline() {`,
      `    const { env, pipeline } = await import('@huggingface/transformers');`,
      `    return pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');`,
      `  }`,
      `}`,
    ].join('\n');

    // Use a non-bootstrap path. The gate's reachable-module sweep zeroes-out
    // forbiddenDynamicImports for non-bootstrap files, so we mirror that here.
    const reachablePolicy: CloudBootstrapPolicy = {
      ...DEFAULT_POLICY,
      forbiddenBootstrapCalls: [],
      forbiddenDynamicImports: [],
    };
    const violations = findCloudBootstrapPolicyViolations(
      source,
      'cloud-service/src/services/cloudEmbeddingGenerator.ts',
      reachablePolicy,
    );
    expect(violations).toEqual([]);
  });
});

describe('findCloudBootstrapPolicyViolations — synthetic violation fixtures', () => {
  it('flags a NON-allowlisted @main/* static import in bootstrap.ts', () => {
    const source = [
      `import { unrelated } from '@main/index';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  unrelated();`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('forbidden-main-import');
    expect(violations[0].detail).toContain("@main/index");
    expect(violations[0].line).toBe(1);
    expect(violations[0].suggestion).toMatch(/@core\/.* boundary interface/);
  });

  it('flags a top-level cloudEmbeddingGenerator.warmup() call inside the bootstrap function', () => {
    const source = [
      `import { CloudEmbeddingGenerator } from './services/cloudEmbeddingGenerator';`,
      `import { setEmbeddingGeneratorFactory, getEmbeddingGenerator } from '@core/embeddingGenerator';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  setEmbeddingGeneratorFactory(() => new CloudEmbeddingGenerator());`,
      `  const gen = getEmbeddingGenerator();`,
      `  if (gen instanceof CloudEmbeddingGenerator) {`,
      `    await gen.warmup();`,
      `  }`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const calls = violations.filter((v) => v.kind === 'forbidden-call');
    expect(calls).toHaveLength(1);
    expect(calls[0].detail).toContain('.warmup(');
    expect(calls[0].reason).toMatch(/lazy-on-first-use/);
  });

  it('flags a dynamic await import("@huggingface/transformers") in bootstrap.ts (AST vs regex test)', () => {
    // This is the canonical "AST beats grep" case: the dynamic import is
    // multi-line and the specifier is broken across lines, which the existing
    // single-line cross-surface regex would miss. The TS compiler API parses
    // the same source and exposes the string-literal arg cleanly.
    const source = [
      `export async function bootstrap(): Promise<void> {`,
      `  const transformers = await import(`,
      `    '@huggingface/transformers'`,
      `  );`,
      `  console.log(typeof transformers);`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const dynamics = violations.filter((v) => v.kind === 'forbidden-dynamic-import');
    expect(dynamics).toHaveLength(1);
    expect(dynamics[0].detail).toContain('@huggingface/transformers');
    expect(dynamics[0].reason).toMatch(/loads ~80 MB of ONNX weights/);
  });

  it('flags a static import of @huggingface/transformers in bootstrap.ts', () => {
    const source = [
      `import { pipeline } from '@huggingface/transformers';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  void pipeline;`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const statics = violations.filter((v) => v.kind === 'forbidden-static-import');
    expect(statics).toHaveLength(1);
    expect(statics[0].detail).toContain('@huggingface/transformers');
  });

  it('flags initializeToolIndex() called inside the bootstrap function', () => {
    const source = [
      `import { initializeToolIndex } from '@core/services/toolIndex/toolIndexService';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  await initializeToolIndex();`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const calls = violations.filter(
      (v) => v.kind === 'forbidden-call' && v.detail.startsWith('initializeToolIndex'),
    );
    expect(calls).toHaveLength(1);
  });

  it('flags refreshToolIndex() and refreshToolIndexFromCatalogData() in bootstrap.ts', () => {
    const source = [
      `import {`,
      `  refreshToolIndex,`,
      `  refreshToolIndexFromCatalogData,`,
      `} from '@core/services/toolIndex/toolIndexService';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  await refreshToolIndex();`,
      `  await refreshToolIndexFromCatalogData({});`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const callees = violations
      .filter((v) => v.kind === 'forbidden-call')
      .map((v) => v.detail);
    expect(callees).toContain('refreshToolIndex(...)');
    expect(callees).toContain('refreshToolIndexFromCatalogData(...)');
  });

  it('does NOT flag forbidden call patterns when the file is not the bootstrap entry', () => {
    // Inside cloudBootstrapWarmup.ts, calling initializeToolIndex/refreshToolIndex is
    // legitimate — that's the deferred-warmup module that owns the work.
    const source = [
      `export async function runWarmupSequence() {`,
      `  await initializeToolIndex();`,
      `  await refreshToolIndex();`,
      `}`,
      `declare const initializeToolIndex: () => Promise<void>;`,
      `declare const refreshToolIndex: () => Promise<{ total: number }>;`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(
      source,
      'cloud-service/src/services/cloudBootstrapWarmup.ts',
    );
    // No call-pattern violations expected for non-bootstrap files.
    const calls = violations.filter((v) => v.kind === 'forbidden-call');
    expect(calls).toEqual([]);
  });
});

describe('findCloudBootstrapPolicyViolations — comments + edge cases', () => {
  it('parses bootstrap.ts with mixed clean and violating constructs and reports correct line numbers', () => {
    const source = [
      `// Stage A3 regression sample`,
      `import path from 'node:path';                   // line 2`,
      `import { setStoreFactory } from '@core/storeFactory';  // line 3`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  await initializeToolIndex();                  // line 6  -- violation`,
      `  console.log('hi');`,
      `  const x = await import('@huggingface/transformers'); // line 8 -- violation`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const summary = detail(violations);
    expect(summary).toEqual(
      expect.arrayContaining([
        { kind: 'forbidden-call', detail: 'initializeToolIndex(...)', line: 6 },
        { kind: 'forbidden-dynamic-import', detail: "import('@huggingface/transformers')", line: 8 },
      ]),
    );
  });

  it('respects the cross-surface allowlist for known-deferred @main/* imports', () => {
    // bundledMcpManager + catalogEnvBackfillMigration are both currently
    // allowlisted in scripts/check-cross-surface-imports.ts. The gate must
    // not flag those when running against bootstrap.ts.
    const source = [
      `import { configureBundledMcpManager } from '@main/services/bundledMcpManager';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  configureBundledMcpManager({ userDataDir: '/tmp', resourcesDir: '/tmp', isPackaged: false });`,
      `  const { backfillCatalogEnvForExistingServers } = await import(`,
      `    '@main/services/catalogEnvBackfillMigration'`,
      `  );`,
      `  await backfillCatalogEnvForExistingServers('/tmp/router.json', { scrubStaleDefaultOnlyEnvKeys: true });`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const mainImports = violations.filter((v) => v.kind === 'forbidden-main-import');
    expect(mainImports).toEqual([]);
  });
});

describe('findCloudBootstrapPolicyViolations — template-literal + type-only handling (Round 2)', () => {
  it('flags a no-substitution template-literal dynamic import in bootstrap.ts', () => {
    // Backticks instead of quotes — a regex pattern matching `import('...')` would
    // miss this entirely. Without the AST fix this test failed (false negative);
    // with `ts.isNoSubstitutionTemplateLiteral` handling the gate catches it.
    const source = [
      'export async function bootstrap(): Promise<void> {',
      '  const transformers = await import(`@huggingface/transformers`);',
      '  console.log(typeof transformers);',
      '}',
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const dynamics = violations.filter((v) => v.kind === 'forbidden-dynamic-import');
    expect(dynamics).toHaveLength(1);
    expect(dynamics[0].detail).toContain('@huggingface/transformers');
  });

  it('does NOT flag a type-only static import of @huggingface/transformers', () => {
    // `import type` is erased at runtime — no eager load can happen, so the gate
    // must not flag it as a forbidden-static-import (false positive class).
    const source = [
      `import type { pipeline } from '@huggingface/transformers';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  const _x: typeof pipeline | undefined = undefined;`,
      `  void _x;`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    expect(violations).toEqual([]);
  });

  it('does NOT add a type-only-only mixed import to the reachability graph', () => {
    // `import { type Foo, runtimeFn } from 'some-mixed-module'` should still pull
    // the module into the reachability graph (runtimeFn is a real runtime export),
    // BUT a fully type-only mixed import (`import { type A, type B }`) should not.
    const mixedRuntime = [
      `import { type Foo, runtimeFn } from './some-mixed-module';`,
      ``,
      `export function entry() { runtimeFn(); }`,
    ].join('\n');
    const allTypeOnly = [
      `import { type A, type B } from './all-type-only';`,
      ``,
      `export const noop = () => undefined;`,
    ].join('\n');

    const sfMixed = ts.createSourceFile(
      'mixed.ts',
      mixedRuntime,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const sfAllTypeOnly = ts.createSourceFile(
      'all-type-only.ts',
      allTypeOnly,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );

    expect(collectImportSpecifiers(sfMixed)).toContain('./some-mixed-module');
    expect(collectImportSpecifiers(sfAllTypeOnly)).not.toContain('./all-type-only');
  });

  it('does NOT add a type-only re-export target to the reachability graph', () => {
    // `export type { Bar } from '@huggingface/transformers'` is erased at
    // runtime; the reachability walker must not follow it. Without this fix
    // the walker would inflate the graph with type-only modules and
    // potentially cascade false positives on those modules' static imports.
    const reExportSource = [
      `export type { Bar } from '@huggingface/transformers';`,
    ].join('\n');
    const namedTypeOnlyReExport = [
      `export { type Foo } from '@huggingface/transformers';`,
    ].join('\n');
    const runtimeReExport = [
      `export { pipeline } from '@huggingface/transformers';`,
    ].join('\n');

    const sfReExport = ts.createSourceFile(
      're-export.ts',
      reExportSource,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const sfNamedTypeOnly = ts.createSourceFile(
      'named-type-only.ts',
      namedTypeOnlyReExport,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const sfRuntime = ts.createSourceFile(
      'runtime.ts',
      runtimeReExport,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );

    expect(collectImportSpecifiers(sfReExport)).not.toContain('@huggingface/transformers');
    expect(collectImportSpecifiers(sfNamedTypeOnly)).not.toContain('@huggingface/transformers');
    // Runtime re-export sanity: must still drag the module in.
    expect(collectImportSpecifiers(sfRuntime)).toContain('@huggingface/transformers');
  });
});

describe('findCloudBootstrapPolicyViolations — unguarded pre-init singleton accessor (rule 5)', () => {
  it('flags an UNGUARDED getSystemSettingsPath() inside bootstrap() — the reverted REBEL-63K Stage 3 shape', () => {
    const source = [
      `import path from 'node:path';`,
      `import { getSystemSettingsPath } from '@core/services/systemSettingsSync';`,
      `import { configurePromptFileService } from '@core/services/promptFileService';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  const promptsPath = path.join(getSystemSettingsPath(), 'prompts');`,
      `  configurePromptFileService(promptsPath);`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toHaveLength(1);
    expect(accessors[0].detail).toContain('getSystemSettingsPath');
    expect(accessors[0].detail).toContain('unguarded');
    expect(accessors[0].line).toBe(6);
    expect(accessors[0].reason).toMatch(/PlatformConfig not initialized/);
  });

  it('does NOT flag a GUARDED getSystemSettingsPath() inside a try block (the Stage 3 fix posture)', () => {
    const source = [
      `import path from 'node:path';`,
      `import { getSystemSettingsPath } from '@core/services/systemSettingsSync';`,
      `import { configurePromptFileService, warmAllPrompts } from '@core/services/promptFileService';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  try {`,
      `    const promptsPath = path.join(getSystemSettingsPath(), 'prompts');`,
      `    configurePromptFileService(promptsPath);`,
      `    await warmAllPrompts();`,
      `  } catch (err) {`,
      `    console.error(err);`,
      `  }`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toEqual([]);
  });

  it('flags all five accessors when each is called unguarded inside bootstrap()', () => {
    const source = [
      `import { getSystemSettingsPath } from '@core/services/systemSettingsSync';`,
      `import { getDataPath, getAppRoot, getAppVersion } from '@core/utils/dataPaths';`,
      `import { getPlatformConfig } from '@core/platform';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  getSystemSettingsPath();`,
      `  getDataPath();`,
      `  getAppRoot();`,
      `  getAppVersion();`,
      `  getPlatformConfig();`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const callees = violations
      .filter((v) => v.kind === 'unguarded-preinit-accessor')
      .map((v) => v.detail.split('(')[0]);
    expect(callees).toEqual(
      expect.arrayContaining([
        'getSystemSettingsPath',
        'getDataPath',
        'getAppRoot',
        'getAppVersion',
        'getPlatformConfig',
      ]),
    );
    expect(callees).toHaveLength(5);
  });

  it('does NOT flag an accessor called in a DIFFERENT named function (function-scoped, not file-scoped)', () => {
    // Mirrors bootstrap.ts:1840 — getDataPath() in the IPC-handler registration
    // function, NOT in bootstrap()'s body. Pre-existing + benign → must not fire.
    const source = [
      `import { getDataPath } from '@core/utils/dataPaths';`,
      ``,
      `export function registerSessionsHandlers(): void {`,
      `  const locksDirectory = getDataPath() + '/sessions-locks';`,
      `  void locksDirectory;`,
      `}`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  registerSessionsHandlers();`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toEqual([]);
  });

  it('does NOT flag an accessor in a module-scope lazy closure (deferred call, not boot work)', () => {
    // Mirrors bootstrap.ts:599 — getDataPath() inside a tokenRootResolver closure
    // constructed at module scope; the call is deferred to runtime, not boot.
    const source = [
      `import { getDataPath } from '@core/utils/dataPaths';`,
      ``,
      `const coordinator = {`,
      `  tokenRootResolver: () => getDataPath(),`,
      `};`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  void coordinator;`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toEqual([]);
  });

  it('does NOT flag pre-init accessors when the file is not the bootstrap entry', () => {
    const source = [
      `import { getSystemSettingsPath } from '@core/services/systemSettingsSync';`,
      `export async function bootstrap(): Promise<void> {`,
      `  getSystemSettingsPath();`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(
      source,
      'cloud-service/src/services/cloudBootstrapWarmup.ts',
    );
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toEqual([]);
  });

  it('does NOT flag an accessor reachable from bootstrap() but inside a try in the SAME body even when a sibling sequence is unguarded', () => {
    // Guard ONE accessor, leave another unguarded — only the unguarded one fires.
    const source = [
      `import { getSystemSettingsPath } from '@core/services/systemSettingsSync';`,
      `import { getDataPath } from '@core/utils/dataPaths';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  try {`,
      `    getSystemSettingsPath();`,
      `  } catch (err) { void err; }`,
      `  getDataPath();`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toHaveLength(1);
    expect(accessors[0].detail).toContain('getDataPath');
  });

  // -- F2: a "try" is only a guard if it has a non-rethrowing catch. ---------
  it('FLAGS a rethrowing-catch try (catch (e) { throw e }) — not a real guard, throw still escapes', () => {
    // The accessor's throw propagates straight out of the rethrowing catch, so
    // boot still crashes when unwired. This must FAIL the gate (F2 false-negative
    // closed). Before F2 the coarse "lexically inside a try" signal passed it.
    const source = [
      `import path from 'node:path';`,
      `import { getSystemSettingsPath } from '@core/services/systemSettingsSync';`,
      `import { configurePromptFileService } from '@core/services/promptFileService';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  try {`,
      `    const promptsPath = path.join(getSystemSettingsPath(), 'prompts');`,
      `    configurePromptFileService(promptsPath);`,
      `  } catch (err) {`,
      `    throw err;`,
      `  }`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toHaveLength(1);
    expect(accessors[0].detail).toContain('getSystemSettingsPath');
  });

  it('FLAGS a rethrowing-catch that throws a NEW error (catch { throw new Error() }) — still fatal', () => {
    const source = [
      `import { getPlatformConfig } from '@core/platform';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  try {`,
      `    getPlatformConfig();`,
      `  } catch (err) {`,
      `    throw new Error('boot failed: ' + String(err));`,
      `  }`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toHaveLength(1);
    expect(accessors[0].detail).toContain('getPlatformConfig');
  });

  it('FLAGS a log-then-rethrow catch (catch (e) { log(e); throw e }) — re-throw after logging still escapes', () => {
    // The natural "log then re-throw" shape: the throw is NOT the first catch
    // statement, but it is still a top-level statement, so the accessor's throw
    // escapes and boot crashes when unwired. Must FAIL the gate (the throw is
    // detected anywhere in the catch body, not just as the leading statement).
    const source = [
      `import path from 'node:path';`,
      `import { getSystemSettingsPath } from '@core/services/systemSettingsSync';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  try {`,
      `    const promptsPath = path.join(getSystemSettingsPath(), 'prompts');`,
      `    void promptsPath;`,
      `  } catch (err) {`,
      `    console.error('boot failed', err);`,
      `    throw err;`,
      `  }`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toHaveLength(1);
    expect(accessors[0].detail).toContain('getSystemSettingsPath');
  });

  it('FLAGS a catch-less try/finally — finally cannot swallow the throw, so it is not a guard', () => {
    const source = [
      `import path from 'node:path';`,
      `import { getSystemSettingsPath } from '@core/services/systemSettingsSync';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  try {`,
      `    const promptsPath = path.join(getSystemSettingsPath(), 'prompts');`,
      `    void promptsPath;`,
      `  } finally {`,
      `    console.log('done');`,
      `  }`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toHaveLength(1);
    expect(accessors[0].detail).toContain('getSystemSettingsPath');
  });

  it('does NOT flag an accessor wrapped by an OUTER real guard even when an inner try is a rethrowing non-guard', () => {
    // The inner try rethrows (not a guard), but the OUTER try has a swallowing
    // catch — the throw is ultimately caught, so the accessor is guarded. The
    // walk must keep ascending past the rethrowing inner try.
    const source = [
      `import { getSystemSettingsPath } from '@core/services/systemSettingsSync';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  try {`,
      `    try {`,
      `      getSystemSettingsPath();`,
      `    } catch (inner) {`,
      `      throw inner;`,
      `    }`,
      `  } catch (outer) {`,
      `    console.error(outer);`,
      `  }`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toEqual([]);
  });

  // -- F2 known-limitation: namespace/property calls are NOT detected. -------
  it('documents the namespace-form bypass: dataPaths.getDataPath() is NOT flagged (known limitation)', () => {
    // The gate only matches BARE-IDENTIFIER calls (ts.isIdentifier). A
    // namespace/property call is a PropertyAccessExpression, which rule 5 does
    // not inspect. This fixture pins the CURRENT (non-)behaviour so the
    // documented "bare-identifier eager calls" claim stays honest, rather than
    // the gate silently appearing to cover a form it doesn't. Closing this would
    // need symbol/dataflow analysis (over-engineering for this gate).
    const source = [
      `import * as dataPaths from '@core/utils/dataPaths';`,
      ``,
      `export async function bootstrap(): Promise<void> {`,
      `  const dir = dataPaths.getDataPath();`,
      `  void dir;`,
      `}`,
    ].join('\n');

    const violations = findCloudBootstrapPolicyViolations(source, BOOTSTRAP_ENTRY);
    const accessors = violations.filter((v) => v.kind === 'unguarded-preinit-accessor');
    expect(accessors).toEqual([]);
  });
});

describe('DEFAULT_POLICY structure', () => {
  it('matches the documented bootstrap entry path', () => {
    expect(DEFAULT_POLICY.bootstrapEntryPath).toBe('cloud-service/src/bootstrap.ts');
  });

  it('forbids the four documented call patterns', () => {
    const callees = DEFAULT_POLICY.forbiddenBootstrapCalls.map((c) => c.callee);
    expect(callees).toEqual(
      expect.arrayContaining([
        'warmup',
        'initializeToolIndex',
        'refreshToolIndex',
        'refreshToolIndexFromCatalogData',
      ]),
    );
  });

  it('forbids @huggingface/transformers as both static and dynamic import', () => {
    expect(DEFAULT_POLICY.forbiddenStaticImports.map((p) => p.specifier))
      .toContain('@huggingface/transformers');
    expect(DEFAULT_POLICY.forbiddenDynamicImports.map((p) => p.specifier))
      .toContain('@huggingface/transformers');
  });

  it('forbids the five documented pre-init singleton accessors, scoped to bootstrap()', () => {
    expect(DEFAULT_POLICY.bootstrapFunctionName).toBe('bootstrap');
    const callees = DEFAULT_POLICY.forbiddenPreInitAccessors.map((a) => a.callee);
    expect(callees).toEqual(
      expect.arrayContaining([
        'getSystemSettingsPath',
        'getDataPath',
        'getAppRoot',
        'getAppVersion',
        'getPlatformConfig',
      ]),
    );
  });
});
