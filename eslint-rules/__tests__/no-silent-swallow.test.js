import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rule = require('../no-silent-swallow.js');

// First behavioral RuleTester suite for `no-silent-swallow` (the rule shipped
// with only a presence smoke — scripts/__tests__/silent-swallow-rule-presence.test.ts —
// and no behavioral coverage). This suite both PINS the rule's existing
// behavior (so the empty-collection extension can't silently regress it) and
// drives the Stage-2 extension red→green.
//
// Lever (docs/plans/260620_defect-defense-hardening/PLAN.md, Stages 1-2): a
// catch / `.catch()` fallback return of an EMPTY COLLECTION (`[]` or `{}`) is a
// silent fail-open swallow and should be flagged — but ONLY when the catch
// records NO observability. The discriminator is *absence of observability*,
// NOT the literal returned (the DA proved 91/129 such returns are observable
// and would be false positives under a literal-only rule). Observability that
// exempts the return: the sanctioned ignoreBestEffortCleanup helper, a
// structured log.*/logger.* call, an error-reporter capture
// (captureException/reportError/*.capture*), a `throw` (rethrow), or an
// expected-error-narrowed branch (return guarded by err.code/ENOENT/errno/.name).
// `console.*` does NOT count (consistent with the existing noOpCatch stance).

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

// A non-canonical-helper-file path so the rule does not early-return.
const productionFile = 'src/core/services/exampleService.ts';

ruleTester.run('no-silent-swallow', rule, {
  valid: [
    // ----------------------------------------------------------------------
    // PIN EXISTING BEHAVIOR — valid cases that must stay valid post-extension.
    // ----------------------------------------------------------------------
    {
      name: 'EXISTING: helper-mediated cleanup before a sentinel return is allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (error) {
            ignoreBestEffortCleanup(error, { operation: 'load', reason: 'best-effort fallback' });
            return null;
          }
        }
      `,
    },
    {
      name: 'EXISTING: catch that rethrows is allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (error) {
            throw error;
          }
        }
      `,
    },
    {
      name: 'EXISTING: catch that handles the error (real work, no swallow) is allowed',
      filename: productionFile,
      code: `
        function load(state) {
          try {
            doWork();
          } catch (error) {
            state.lastError = error;
            state.failed = true;
          }
        }
      `,
    },
    {
      name: 'EXISTING: .catch with a helper-mediated concise body is allowed',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch((error) =>
            ignoreBestEffortCleanup(error, { operation: 'load', reason: 'best-effort fallback' }),
          );
        }
      `,
    },
    {
      name: 'EXISTING: .catch block body with a helper call is allowed',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch((error) => {
            ignoreBestEffortCleanup(error, { operation: 'load', reason: 'best-effort fallback' });
            return null;
          });
        }
      `,
    },

    // ----------------------------------------------------------------------
    // NEW NEGATIVE CASES — empty-collection returns that ARE observable
    // (must stay valid: these bound the false positives the DA identified).
    // ----------------------------------------------------------------------
    {
      name: 'NEW: structured log.warn before `return []` is observable → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            log.warn({ err: e }, 'load failed, returning empty');
            return [];
          }
        }
      `,
    },
    {
      name: 'NEW: logger.error before `return {}` is observable → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            logger.error({ err: e }, 'load failed');
            return {};
          }
        }
      `,
    },
    {
      name: 'NEW: error-reporter capture before `return {}` is observable → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            getErrorReporter().captureException(e);
            return {};
          }
        }
      `,
    },
    {
      name: 'NEW: bare captureException(e) before `return []` is observable → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            captureException(e);
            return [];
          }
        }
      `,
    },
    {
      name: 'NEW: reportError before `return []` is observable → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            reportError(e);
            return [];
          }
        }
      `,
    },
    {
      name: 'NEW: expected-error narrowing (ENOENT) then rethrow → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            if (e.code === 'ENOENT') return [];
            throw e;
          }
        }
      `,
    },
    {
      name: 'NEW: expected-error narrowing via .name then observable fallback → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            if (e.name === 'NotFoundError') return {};
            log.warn({ err: e }, 'load failed');
            return {};
          }
        }
      `,
    },
    {
      name: 'NEW: helper-mediated cleanup before `return []` is allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            ignoreBestEffortCleanup(e, { operation: 'load', reason: 'directory missing is fine' });
            return [];
          }
        }
      `,
    },
    {
      name: 'NEW: rethrow anywhere in the catch exempts an earlier `return {}`',
      filename: productionFile,
      code: `
        function load(allowEmpty) {
          try {
            return doWork();
          } catch (e) {
            if (allowEmpty) return {};
            throw e;
          }
        }
      `,
    },
    {
      name: 'NEW: non-catch control-flow `return []` must NOT flag (catch-local scoping)',
      filename: productionFile,
      code: `
        function findItems(items) {
          if (!items) {
            return [];
          }
          return items;
        }
      `,
    },
    {
      name: 'NEW: non-catch control-flow `return {}` must NOT flag (catch-local scoping)',
      filename: productionFile,
      code: `
        function defaults(config) {
          if (!config) {
            return {};
          }
          return config;
        }
      `,
    },
    {
      name: 'NEW: .catch block body with log.warn before `return []` is observable → allowed',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch((e) => {
            log.warn({ err: e }, 'load failed');
            return [];
          });
        }
      `,
    },
    {
      name: 'NEW: .catch block body with capture before `return {}` is observable → allowed',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch((e) => {
            captureException(e);
            return {};
          });
        }
      `,
    },
    {
      name: 'NEW: .catch block body with helper before `return []` is allowed',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch((e) => {
            ignoreBestEffortCleanup(e, { operation: 'load', reason: 'best-effort fetch' });
            return [];
          });
        }
      `,
    },
    {
      // Phase-7 F1: the empty-collection detection in a block-bodied `.catch()`
      // now traverses the callback body. A NESTED `return []` (inside an `if`) is
      // covered — so this observable variant must stay valid (the log exempts it).
      name: 'NEW(F1): .catch block with NESTED `return []` made observable (log.warn) → allowed',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch((e) => {
            if (shouldFallback(e)) {
              log.warn({ err: e }, 'load failed, returning empty');
              return [];
            }
          });
        }
      `,
    },

    // ----------------------------------------------------------------------
    // NEW (harmonization 2026-06-20): the SCALAR sentinel path now credits the
    // SAME observability the empty-collection path does (was helper-only). A
    // logged/captured/rethrown/narrowed scalar fallback is observable → allowed.
    // ----------------------------------------------------------------------
    {
      name: 'NEW(harmonize): scalar `return null` after log.warn is observable → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            log.warn({ err: e }, 'load failed, returning null');
            return null;
          }
        }
      `,
    },
    {
      name: 'NEW(harmonize): scalar `return false` after captureException is observable → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            captureException(e);
            return false;
          }
        }
      `,
    },
    {
      name: 'NEW(harmonize): scalar `return undefined` with ENOENT narrowing + rethrow → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            if (e.code === 'ENOENT') return undefined;
            throw e;
          }
        }
      `,
    },
    {
      name: 'NEW(harmonize): bare `return` with ENOENT narrowing + rethrow → allowed',
      filename: productionFile,
      code: `
        function load() {
          try {
            doWork();
          } catch (e) {
            if (e.code === 'ENOENT') return;
            throw e;
          }
        }
      `,
    },
    {
      name: 'NEW(harmonize): .catch block scalar `return null` after log.warn → allowed',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch((e) => {
            log.warn({ err: e }, 'load failed');
            return null;
          });
        }
      `,
    },
    {
      // #4-PLAN deferred: the scalar `.catch()` scan is TOP-LEVEL ONLY on
      // purpose — a NESTED bare `return` is overwhelmingly a control-flow
      // cancellation guard, not a fail-open sentinel (measured +25 mostly-FP).
      // This documents that we deliberately do NOT flag it.
      name: 'NEW(#4-PLAN deferred): .catch block NESTED bare `return` (cancellation guard) is NOT flagged',
      filename: productionFile,
      code: `
        function load(cancelled) {
          return doWorkAsync()
            .then((r) => { use(r); })
            .catch((e) => {
              if (cancelled) return;
              showError(e);
            });
        }
      `,
    },
  ],

  invalid: [
    // ----------------------------------------------------------------------
    // PIN EXISTING BEHAVIOR — invalid cases that must stay invalid.
    // ----------------------------------------------------------------------
    {
      name: 'EXISTING: empty catch is flagged (emptyCatch)',
      filename: productionFile,
      code: `
        function load() {
          try {
            doWork();
          } catch (error) {
          }
        }
      `,
      errors: [{ messageId: 'emptyCatch' }],
    },
    {
      name: 'EXISTING: console-only catch is flagged (noOpCatch)',
      filename: productionFile,
      code: `
        function load() {
          try {
            doWork();
          } catch (error) {
            console.error('failed', error);
          }
        }
      `,
      errors: [{ messageId: 'noOpCatch' }],
    },
    {
      name: 'EXISTING: `catch { return null }` without helper is flagged (sentinelReturn)',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (error) {
            return null;
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'EXISTING: `catch { return false }` without helper is flagged (sentinelReturn)',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (error) {
            return false;
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'EXISTING: `catch { return undefined }` without helper is flagged (sentinelReturn)',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (error) {
            return undefined;
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'EXISTING: `.catch(() => {})` is flagged (emptyCatch)',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch(() => {});
        }
      `,
      errors: [{ messageId: 'emptyCatch' }],
    },
    {
      name: 'EXISTING: `.catch(() => null)` is flagged (sentinelReturn)',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch(() => null);
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },

    // ----------------------------------------------------------------------
    // NEW RED CASES — empty-collection silent swallows (flag after Stage 2;
    // confirmed NOT flagged by the current rule before the change).
    // ----------------------------------------------------------------------
    {
      name: 'NEW: silent `catch { return [] }` (bug-#3 reconstruction) is flagged',
      filename: productionFile,
      code: `
        function loadMessages(raw) {
          try {
            return JSON.parse(raw).messages.filter((m) => m.role);
          } catch {
            return [];
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'NEW: silent `catch { return {} }` (live mcpConfigManager shape) is flagged',
      filename: productionFile,
      code: `
        async function readConfig(configPath) {
          try {
            const raw = await fs.readFile(configPath, 'utf8');
            return JSON.parse(raw);
          } catch {
            return {};
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'NEW: silent `catch (e) { return [] }` with a binding but no observability is flagged',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            return [];
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'NEW: `.catch(() => [])` concise arrow is flagged',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch(() => []);
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'NEW: `.catch(() => ({}))` concise arrow is flagged',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch(() => ({}));
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'NEW: `.catch(() => { return []; })` block body with no observability is flagged',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch(() => {
            return [];
          });
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'NEW: console-only before `return []` is still silent (console ≠ observability)',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            console.error('load failed', e);
            return [];
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'NEW: cast empty array `return [] as Foo[]` (unwrapExpression) is flagged',
      filename: productionFile,
      code: `
        function load(): Foo[] {
          try {
            return doWork();
          } catch {
            return [] as Foo[];
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },

    // ----------------------------------------------------------------------
    // NEW BOUNDARY CASES (Phase-5 F1, flagged independently by both stage
    // reviewers): observability inside a NESTED try/catch belongs to a
    // DIFFERENT (inner) error and must NOT absolve the OUTER swallow. Locks the
    // catch-local boundary on BOTH the block-catch and the `.catch()` paths.
    // ----------------------------------------------------------------------
    {
      name: 'NEW(F1): nested-catch observability does not absolve outer `catch { return [] }`',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (outerError) {
            try {
              cleanup();
            } catch (innerError) {
              log.warn({ err: innerError }, 'cleanup failed');
            }
            return [];
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'NEW(F1): nested-catch observability does not absolve outer `.catch(() => { return [] })`',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch((outerError) => {
            try {
              cleanup();
            } catch (innerError) {
              log.warn({ err: innerError }, 'cleanup failed');
            }
            return [];
          });
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },

    // ----------------------------------------------------------------------
    // NEW (Phase-7 F1): block-bodied `.catch()` empty-collection detection now
    // TRAVERSES the callback body (lockstep with `collectCatchFacts`), so a
    // NESTED `return []` inside an `if`/loop is flagged — not just a top-level
    // statement. Confirmed NOT flagged by the pre-Phase-7 rule (top-level-only
    // `stmts.some(...)`); IS flagged now.
    // ----------------------------------------------------------------------
    {
      name: 'NEW(F1): `.catch((e) => { if (cond) return []; })` nested empty-collection is flagged',
      filename: productionFile,
      code: `
        function load() {
          return doWorkAsync().catch((e) => {
            if (shouldFallback(e)) {
              return [];
            }
          });
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },

    // ----------------------------------------------------------------------
    // NEW (harmonization 2026-06-20): the scalar path still flags swallows that
    // record no observability; console.* still does not count; the CatchClause
    // path still traverses nested scalar returns; and the catch-local boundary
    // still applies to scalars (inner-catch observability ≠ outer absolution).
    // ----------------------------------------------------------------------
    {
      name: 'NEW(harmonize): console-only before scalar `return null` is still flagged (console ≠ observability)',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (e) {
            console.error('load failed', e);
            return null;
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'NEW(harmonize): CatchClause NESTED scalar `return null` with no observability is flagged (traverses)',
      filename: productionFile,
      code: `
        function load(useFallback) {
          try {
            return doWork();
          } catch (e) {
            if (useFallback) {
              return null;
            }
            doSomethingUnrelated();
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
    {
      name: 'NEW(harmonize): nested-catch observability does not absolve outer scalar `return null`',
      filename: productionFile,
      code: `
        function load() {
          try {
            return doWork();
          } catch (outerError) {
            try {
              cleanup();
            } catch (innerError) {
              log.warn({ err: innerError }, 'cleanup failed');
            }
            return null;
          }
        }
      `,
      errors: [{ messageId: 'sentinelReturn' }],
    },
  ],
});
