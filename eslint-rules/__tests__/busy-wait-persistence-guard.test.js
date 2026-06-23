// Self-test for the same-process busy-wait guard in the session-persistence layer
// (busyWaitPersistenceGuardSelectors in eslint-rules/busy-wait-persistence-guard-selectors.mjs).
// PM 260618_quit_save_sync_lock_contention_dropped_final_save, rec 2 (implement_now):
// a NEW acquire*Sync / Atomics.wait / sleepSync busy-wait site in the persistence consumer
// must fire `no-restricted-syntax`, the eslint-disable escape hatch must silence it, and the
// guard must be SCOPED (it must NOT fire in a generic core file — the lock primitive
// sessionFileLock.ts and other core code keep their unrestricted busy-wait usage).
//
// SHAPE (see eslint-rules/routing-state-writer-selectors.mjs precedent): VERDICT tests lint
// synthetic snippets against a minimal NON-type-aware flat config that contains ONLY the SSOT
// selectors — no `parserOptions.project`, so no TS program is built. The prior version booted
// the FULL production eslint.config.mjs through `ESLint.lintText()` against a `src/core/**`
// filePath, forcing a cold lint to build the full type-aware TS program; that intermittently
// returned ZERO messages under parallel CI load (eslint@10 / esquery on CI Node) and red the
// desktop unit-test shard on every run. A separate WIRING+SCOPING assertion uses
// `ESLint.calculateConfigForFile()` (config resolution only, no lint, no program build) to
// prove the production config still applies these selectors to the persistence consumer —
// and ONLY to it. Together: selectors-fire (minimal lint) + selectors-are-wired (config
// resolution) = the same guarantee the old all-in-one lintText test gave, without the flake.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { beforeAll, describe, expect, it } from 'vitest';
// SSOT: the exact selectors the production eslint.config.mjs spreads onto
// lockedSessionPersistence.ts. Importing them (rather than copying) means removing or
// altering a production selector breaks this test by construction.
import { busyWaitPersistenceGuardSelectors } from '../busy-wait-persistence-guard-selectors.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULE_ID = 'no-restricted-syntax';
// Distinctive substring present only in busyWaitPersistenceGuardSelectors' messages.
const GUARD_MARKER = 'PM 260618_quit_save_sync_lock_contention';
const PERSISTENCE_CONSUMER = 'src/core/services/lockedSessionPersistence.ts';
// The canonical lock primitive — explicitly the sanctioned busy-wait home and
// intentionally OUT of the guard's scope (cf. the eslint.config.mjs comment).
// A semantically meaningful negative probe: if the guard ever leaked onto it,
// that's a real scoping regression.
const OUT_OF_SCOPE_FILE = 'src/core/utils/sessionFileLock.ts';

/** @type {ESLint} */
let minimalEslint;
/** @type {ESLint} */
let productionEslint;

beforeAll(() => {
  // Minimal NON-type-aware config containing ONLY the SSOT busy-wait selectors. The selectors
  // are pure AST (esquery), so a parser-only lint catches the same sites the production
  // type-aware lint does — fast (~10ms) and deterministic (no TS program → no parallel-load flake).
  minimalEslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tsparser,
          parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        },
        rules: {
          'no-restricted-syntax': ['error', ...busyWaitPersistenceGuardSelectors],
        },
      },
    ],
    ignore: false,
  });
  // The real production config, used ONLY for config RESOLUTION (calculateConfigForFile),
  // never for lintText — resolution does not build a TS program, so it does not flake.
  productionEslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: resolve(repoRoot, 'eslint.config.mjs'),
  });
});

/**
 * Lint a synthetic snippet against the minimal selectors-only config.
 * @param {string} code
 * @returns {Promise<boolean>} whether the busy-wait guard reported a severity:2 error
 */
async function busyWaitGuardFires(code) {
  // filePath drives parser selection only; the snippet is virtual. Use the consumer path so
  // the .ts parser is selected, but the verdict is the minimal config's, not production's.
  const [result] = await minimalEslint.lintText(code, { filePath: resolve(repoRoot, PERSISTENCE_CONSUMER) });
  return result.messages.some(
    (m) => m.ruleId === RULE_ID && m.severity === 2 && typeof m.message === 'string' && m.message.includes(GUARD_MARKER),
  );
}

/**
 * Resolve the PRODUCTION config for a file and return its `no-restricted-syntax` rule entry
 * as `[severity, ...selectorObjects]` (or null if the rule is not configured for the file).
 * No lint / no TS program is built — config resolution only, so it never flakes.
 * @param {string} relPath
 * @returns {Promise<unknown[] | null>}
 */
async function resolveRestrictedSyntax(relPath) {
  const config = await productionEslint.calculateConfigForFile(resolve(repoRoot, relPath));
  const ruleEntry = config?.rules?.[RULE_ID];
  return Array.isArray(ruleEntry) ? ruleEntry : null;
}

/** Whether ANY busy-wait guard selector (by the distinctive marker) is wired for a file. */
async function busyWaitGuardWiredFor(relPath) {
  const ruleEntry = await resolveRestrictedSyntax(relPath);
  if (!ruleEntry) return false;
  return ruleEntry
    .slice(1)
    .some((opt) => opt && typeof opt === 'object' && typeof opt.message === 'string' && opt.message.includes(GUARD_MARKER));
}

describe('busy-wait persistence guard selectors (verdict)', () => {
  it('fires on a new acquire*Sync site', async () => {
    const bad = `export function f(lock) {\n  return lock.acquireGlobalIndexSync({});\n}\n`;
    expect(await busyWaitGuardFires(bad)).toBe(true);
  });

  it('fires on a new Atomics.wait site', async () => {
    const bad = `export function f(signal) {\n  Atomics.wait(signal, 0, 0, 5);\n}\n`;
    expect(await busyWaitGuardFires(bad)).toBe(true);
  });

  it('fires on a new sleepSync site', async () => {
    const bad = `declare function sleepSync(ms: number): void;\nexport function f() {\n  sleepSync(5);\n}\n`;
    expect(await busyWaitGuardFires(bad)).toBe(true);
  });

  it('is silenced by the eslint-disable escape hatch', async () => {
    const ok = `export function f(lock) {\n  // eslint-disable-next-line no-restricted-syntax -- sync-acquire-after-holder-check-justified: drained in-process holders first\n  return lock.acquireGlobalIndexSync({});\n}\n`;
    expect(await busyWaitGuardFires(ok)).toBe(false);
  });
});

describe('busy-wait persistence guard wiring + scope (production config)', () => {
  it('wires ALL busy-wait selectors at error severity onto the persistence consumer', async () => {
    const ruleEntry = await resolveRestrictedSyntax(PERSISTENCE_CONSUMER);
    expect(ruleEntry).not.toBeNull();
    // Severity must be error (string 'error' or numeric 2) — a downgrade would silently
    // neuter the guard, which this assertion now catches (stage-review F1).
    expect([2, 'error']).toContain(ruleEntry[0]);
    // EVERY SSOT selector must be present by its exact selector string — catches partial
    // unwiring (e.g. production keeping only 1 of the 3), which the marker-only check missed.
    const wiredSelectors = new Set(
      ruleEntry.slice(1).filter((opt) => opt && typeof opt === 'object').map((opt) => opt.selector),
    );
    for (const { selector } of busyWaitPersistenceGuardSelectors) {
      expect(wiredSelectors.has(selector)).toBe(true);
    }
  });

  it('does NOT wire the guard onto the sanctioned busy-wait primitive (scope = consumer only)', async () => {
    expect(await busyWaitGuardWiredFor(OUT_OF_SCOPE_FILE)).toBe(false);
  });
});
