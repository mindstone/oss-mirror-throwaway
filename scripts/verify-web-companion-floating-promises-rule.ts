/**
 * Negative-enforcement smoke for the web-companion floating-promises rule.
 *
 * Purpose: detect silent drift if someone later removes
 * `@typescript-eslint/no-floating-promises`, drops `parserOptions.project`,
 * flips `ignoreVoid: true`, or re-ignores `__tests__` in the web-companion
 * ESLint block.
 *
 * Lints two fixture strings (one bare floating promise, one `void`-prefixed
 * floating promise) against FOUR real file paths that exist in the
 * web-companion tsconfig (ESLint's type-aware parser requires paths be in
 * the TS program — virtual paths fail with "TSConfig does not include this
 * file"). We lint the fixture *text* at those paths with `lintText`, so no
 * actual repo source is read or mutated. The paths are chosen to cover the
 * entire enforcement surface (ts + tsx X production + tests X multiple
 * directories), so a regression that accidentally narrows the rule to
 * a single glob would break the smoke instead of silently passing
 * (Phase-5 Behavioral-Safety + Testability must-address):
 *   - `web-companion/src/screens/HomeScreen.tsx`                   (prod tsx, screens)
 *   - `web-companion/src/utils/fireAndForget.ts`                   (prod ts, non-screen)
 *   - `web-companion/src/screens/__tests__/ConversationScreen.test.tsx` (test tsx)
 *   - `web-companion/src/screens/__tests__/conversationRouteSync.test.ts` (test ts)
 *
 * Exits 0 when the rule fires on BOTH patterns in ALL paths. Exits 1
 * otherwise so the failure mode is "the rule stopped catching regressions"
 * rather than a silent green.
 *
 * Usage:
 *   npx tsx scripts/verify-web-companion-floating-promises-rule.ts
 *
 * See docs/plans/260423_web_companion_no_floating_promises_rollout.md
 * Stage 2 (D12).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const BARE_FIXTURE = `
async function makePromise(): Promise<void> {}
makePromise();
export {};
`;

const VOID_FIXTURE = `
async function makePromise(): Promise<void> {}
void makePromise();
export {};
`;

// Real paths covered by `web-companion/tsconfig.json`. We pass fixture text
// to `lintText`, so the actual on-disk file contents are not read. Four
// paths span the full enforcement surface: prod vs test × tsx vs ts × screens
// vs non-screens. If any future config narrows the rule away from one of
// these axes, the smoke fails on that carrier.
const VIRTUAL_FILES: ReadonlyArray<{ label: string; relPath: string }> = [
  {
    label: 'production, tsx, screens (web-companion/src/**/*.tsx)',
    relPath: 'web-companion/src/screens/HomeScreen.tsx',
  },
  {
    label: 'production, ts, non-screens (web-companion/src/**/*.ts)',
    relPath: 'web-companion/src/utils/fireAndForget.ts',
  },
  {
    label: 'test override, tsx (web-companion/src/**/__tests__/**/*.tsx)',
    relPath: 'web-companion/src/screens/__tests__/ConversationScreen.test.tsx',
  },
  {
    label: 'test override, ts (web-companion/src/**/__tests__/**/*.ts)',
    relPath: 'web-companion/src/screens/__tests__/conversationRouteSync.test.ts',
  },
];

async function lintFixture(
  eslint: ESLint,
  code: string,
  relPath: string,
): Promise<ESLint.LintResult> {
  const absPath = path.join(REPO_ROOT, relPath);
  const results = await eslint.lintText(code, { filePath: absPath });
  if (results.length !== 1) {
    throw new Error(`Expected 1 lint result for ${relPath}, got ${results.length}`);
  }
  return results[0]!;
}

function hasFloatingPromiseError(result: ESLint.LintResult): boolean {
  return result.messages.some(
    (m) => m.ruleId === '@typescript-eslint/no-floating-promises' && m.severity === 2,
  );
}

async function main(): Promise<void> {
  // Preflight: if a carrier path was moved or renamed, fail with a clear
  // message instead of a raw parser error. `lintText` itself only requires
  // the path be in the tsconfig program, but the human-friendly remediation
  // is always "update the carrier list in this script".
  const missingCarriers = VIRTUAL_FILES.filter(
    ({ relPath }) => !fs.existsSync(path.join(REPO_ROOT, relPath)),
  );
  if (missingCarriers.length > 0) {
    console.error(
      '[verify-web-companion-floating-promises-rule] carrier path(s) missing:\n' +
        missingCarriers.map(({ relPath }) => `  - ${relPath}`).join('\n') +
        '\n\nThis script lints fixture text at real file paths in ' +
        'web-companion/tsconfig.json. If the carriers were moved or renamed, ' +
        'update VIRTUAL_FILES in this script.',
    );
    process.exit(1);
  }

  const eslint = new ESLint({ cwd: REPO_ROOT });

  const failures: string[] = [];
  let checks = 0;

  for (const { label, relPath } of VIRTUAL_FILES) {
    for (const [fixtureName, fixture] of [
      ['bare floating promise', BARE_FIXTURE],
      ['void-prefixed floating promise', VOID_FIXTURE],
    ] as const) {
      checks += 1;
      const result = await lintFixture(eslint, fixture, relPath);
      if (!hasFloatingPromiseError(result)) {
        failures.push(
          `  - [${label}] did NOT flag ${fixtureName} at ${relPath}\n` +
            `    messages: ${JSON.stringify(result.messages, null, 2)}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      `[verify-web-companion-floating-promises-rule] FAILED (${failures.length}/${checks} checks)\n` +
        failures.join('\n'),
    );
    console.error(
      '\nThis means the no-floating-promises guarantee has regressed. Check eslint.config.mjs\n' +
        '(web-companion hygiene block + web-companion test override) for:\n' +
        '  - missing `@typescript-eslint/no-floating-promises` rule\n' +
        '  - missing `parserOptions.project: ./web-companion/tsconfig.json`\n' +
        '  - `ignoreVoid: true`\n' +
        '  - accidental `ignores` that excludes the verify paths',
    );
    process.exit(1);
  }

  console.log(
    `[verify-web-companion-floating-promises-rule] OK (${checks}/${checks} fixture/path combinations flagged the rule).`,
  );
}

main().catch((err) => {
  console.error('[verify-web-companion-floating-promises-rule] crashed:', err);
  process.exit(1);
});
