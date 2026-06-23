/**
 * Unit tests for the core bootstrap policy gate (OSS boot-crash class).
 *
 * Verifies the AST-based gate flags MODULE-SCOPE (import-time) calls to
 * PlatformConfig-backed accessors under src/core/**, while NOT flagging the
 * same calls when they are deferred into a function/method/getter body (the
 * shape the toolIndex fix uses).
 *
 * @see scripts/check-core-bootstrap-policy.ts
 * @see src/core/services/toolIndex/toolIndexService.ts (the fixed module)
 */
import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_PLATFORM_ACCESSORS,
  findCoreBootstrapPolicyViolations,
  type CorePolicyViolation,
} from '../check-core-bootstrap-policy';

const FILE = 'src/core/services/example.ts';

function accessors(violations: CorePolicyViolation[]): string[] {
  return violations.map((v) => v.accessor);
}

describe('findCoreBootstrapPolicyViolations — clean (deferred) shapes', () => {
  it('returns zero violations when nothing reads a platform accessor', () => {
    const source = [
      `import path from 'node:path';`,
      `export const NAME = 'x';`,
      `export function compute(a: number): number { return a + 1; }`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('does NOT flag an accessor call inside a function body', () => {
    const source = [
      `import { getDataPath } from '@core/utils/dataPaths';`,
      `export function resolve(): string {`,
      `  return getDataPath();`,
      `}`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('does NOT flag an accessor call inside an arrow body', () => {
    const source = [
      `import { isPackaged } from '@core/utils/dataPaths';`,
      `export const check = (): boolean => isPackaged();`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('does NOT flag a class method / getter / constructor body', () => {
    const source = [
      `import { getAppRoot, getAppVersion, getPlatformConfig } from '@core/x';`,
      `export class Svc {`,
      `  constructor() { this.root = getAppRoot(); }`,
      `  root: string;`,
      `  method() { return getAppVersion(); }`,
      `  get cfg() { return getPlatformConfig(); }`,
      `}`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('does NOT flag the lazy-closure pattern used by the toolIndex fix', () => {
    // Mirrors src/core/services/toolIndex/toolIndexService.ts post-fix: the
    // accessor is read inside a closure that runs on first use, not at import.
    const source = [
      `import { getNativeModuleRequire } from '@core/x';`,
      `let resolved: unknown;`,
      `function resolveNativeRequire() {`,
      `  return (resolved ??= getNativeModuleRequire());`,
      `}`,
      `const nativeRequire = ((id: string) => resolveNativeRequire()(id));`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });
});

describe('findCoreBootstrapPolicyViolations — module-scope (import-time) violations', () => {
  it('flags a top-level const initializer calling an accessor', () => {
    const source = [
      `import { getNativeModuleRequire } from '@core/x';`,
      `const nativeRequire = getNativeModuleRequire();`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(accessors(violations)).toEqual(['getNativeModuleRequire']);
    expect(violations[0].line).toBe(2);
  });

  it('flags a top-level bare (side-effecting) accessor call', () => {
    const source = [
      `import { isPackaged } from '@core/x';`,
      `isPackaged();`,
    ].join('\n');
    expect(accessors(findCoreBootstrapPolicyViolations(source, FILE))).toEqual(['isPackaged']);
  });

  it('flags an accessor call inside a module-scope IIFE body (runs at import)', () => {
    const source = [
      `import { getDataPath } from '@core/x';`,
      `const v = (() => getDataPath())();`,
    ].join('\n');
    expect(accessors(findCoreBootstrapPolicyViolations(source, FILE))).toEqual(['getDataPath']);
  });

  it('flags an accessor call in a module-scope object literal initializer', () => {
    const source = [
      `import { getAppVersion } from '@core/x';`,
      `export const meta = { version: getAppVersion() };`,
    ].join('\n');
    expect(accessors(findCoreBootstrapPolicyViolations(source, FILE))).toEqual(['getAppVersion']);
  });

  it('flags every forbidden accessor used at module scope', () => {
    const source = FORBIDDEN_PLATFORM_ACCESSORS.map(
      (name, i) => `const v${i} = ${name}();`,
    ).join('\n');
    const found = new Set(accessors(findCoreBootstrapPolicyViolations(source, FILE)));
    for (const name of FORBIDDEN_PLATFORM_ACCESSORS) {
      expect(found.has(name)).toBe(true);
    }
  });
});

describe('findCoreBootstrapPolicyViolations — module logger use (kind A)', () => {
  it('flags a top-level scoped-logger call (log.info at import time)', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({ service: 'x' });`,
      `log.info('hi');`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].accessor).toBe('log.info');
    expect(violations[0].line).toBe(3);
  });

  it('flags a top-level bare property READ on the logger (proxy get triggers it)', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `export const level = log.level;`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].accessor).toBe('log.level');
  });

  it('flags a top-level use of an imported `logger` proxy from @core/logger', () => {
    const source = [
      `import { logger } from '@core/logger';`,
      `logger.warn('x');`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].accessor).toBe('logger.warn');
  });

  it('flags createTurnSessionLogger bindings too', () => {
    const source = [
      `import { createTurnSessionLogger } from '@core/logger';`,
      `const log = createTurnSessionLogger({});`,
      `log.debug('x');`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].accessor).toBe('log.debug');
  });

  it('does NOT flag the logger DECLARATION itself (lazy proxy is import-safe)', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({ service: 'x' });`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('does NOT flag logger use inside a function body that is never called at module scope', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `export function f() { log.info('x'); }`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });
});

describe('findCoreBootstrapPolicyViolations — tainted local-function call (kind B)', () => {
  it('flags a top-level call to a local fn whose body uses the logger (settingsStore shape)', () => {
    // Replicates the live src/core/services/settingsStore/index.ts bug:
    // a top-level migration call whose body touches the module logger.
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({ service: 'x' });`,
      `const mig = () => { log.error({}, 'm'); };`,
      `mig();`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    // The mig() call is flagged (kind B). The log.error inside the body is NOT
    // a separate violation because it executes on invocation, not at import.
    expect(violations).toHaveLength(1);
    expect(violations[0].accessor).toBe('mig');
    expect(violations[0].detail).toContain('module scope');
  });

  it('flags a top-level call to a function declaration that reaches an accessor', () => {
    const source = [
      `import { getDataPath } from '@core/x';`,
      `function bootstrapMigration() { const p = getDataPath(); return p; }`,
      `bootstrapMigration();`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations.map((v) => v.accessor)).toContain('bootstrapMigration');
  });

  it('flags transitively through a chain of local function calls', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `function leaf() { log.info('x'); }`,
      `function middle() { leaf(); }`,
      `function top() { middle(); }`,
      `top();`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations.map((v) => v.accessor)).toContain('top');
  });

  it('does NOT flag a tainted local fn that is never called at module scope', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `export function mig() { log.error({}, 'm'); }`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('does NOT flag a local fn whose body touches no accessor/logger', () => {
    const source = [
      `function pure() { return 1 + 1; }`,
      `pure();`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });
});

describe('findCoreBootstrapPolicyViolations — Kind B synchronous-awareness', () => {
  it('does NOT flag logger use deferred into a setInterval callback (runs later)', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `function f() { setInterval(() => log.info('x'), 1); }`,
      `f();`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('does NOT flag logger use inside a RETURNED closure (deferred)', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `function f() { return () => log.info('x'); }`,
      `const g = f();`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('FLAGS a synchronous logger use directly in the body (true positive)', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `function f() { log.error('x'); }`,
      `f();`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations.map((v) => v.accessor)).toContain('f');
  });

  it('FLAGS a synchronous catch-block logger use (catch runs synchronously)', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `function f() { try {} catch (e) { log.warn('x'); } }`,
      `f();`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations.map((v) => v.accessor)).toContain('f');
  });

  it('still flags an accessor reached via a synchronous IIFE inside the body', () => {
    const source = [
      `import { getDataPath } from '@core/x';`,
      `function f() { const v = (() => getDataPath())(); return v; }`,
      `f();`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations.map((v) => v.accessor)).toContain('f');
  });
});

describe('findCoreBootstrapPolicyViolations — Kind B async synchronous-prefix', () => {
  it('FLAGS an async fn that logs BEFORE its first await (synchronous prefix)', () => {
    // An async function runs synchronously up to the first await, so this
    // log.info executes during the module-scope call and crashes pre-bootstrap.
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `async function boot() { log.info('x'); await Promise.resolve(); }`,
      `boot();`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations.map((v) => v.accessor)).toContain('boot');
  });

  it('does NOT flag an async fn that logs AFTER its first await (deferred)', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `async function f() { await Promise.resolve(); log.warn('x'); }`,
      `f();`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('does NOT flag an async fn that logs in a catch after the await (deferred)', () => {
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `async function f() { try { await x() } catch (e) { log.warn('y'); } }`,
      `f();`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('FLAGS a log reachable before any await (in a branch preceding the awaiting branch)', () => {
    // log.info is in the then-branch which precedes the awaiting else-branch in
    // pre-order, so it is in the synchronous prefix and must be flagged.
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `async function f() { if (c) { log.info('x') } else { await y() } }`,
      `f();`,
    ].join('\n');
    const violations = findCoreBootstrapPolicyViolations(source, FILE);
    expect(violations.map((v) => v.accessor)).toContain('f');
  });

  it('does NOT count an await inside a nested non-IIFE closure as the prefix cut', () => {
    // The await belongs to the inner async callback (deferred); the outer fn's
    // synchronous prefix has no logger use of its own.
    const source = [
      `import { createScopedLogger } from '@core/logger';`,
      `const log = createScopedLogger({});`,
      `function f() { setTimeout(async () => { await z(); log.info('x'); }, 0); }`,
      `f();`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });
});

describe('findCoreBootstrapPolicyViolations — out-of-scope (deliberate gaps)', () => {
  it('does NOT flag a namespace/property accessor call (bare-identifier only)', () => {
    const source = [
      `import * as dataPaths from '@core/utils/dataPaths';`,
      `const v = dataPaths.getDataPath();`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });

  it('does NOT flag a module-scope `new X()` (constructor resolution is out of scope)', () => {
    const source = [
      `import { Svc } from '@core/x';`,
      `const svc = new Svc();`,
    ].join('\n');
    expect(findCoreBootstrapPolicyViolations(source, FILE)).toEqual([]);
  });
});
