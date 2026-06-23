#!/usr/bin/env npx tsx
/**
 * Anti-false-green construction guard for real-boot agent-turn tests.
 *
 * WHY: `src/test-utils/bootRealAgentServices.ts` exists SPECIFICALLY to run the
 * provider seam REAL (only `globalThis.fetch` is stubbed) so a real-boot turn
 * test asserts on the captured WIRE body instead of reading call-args back from
 * a `vi.fn()`. The two provider-seam modules are:
 *     @core/rebelCore/queryRouter   (queryRouter → rebelCoreQuery → AnthropicClient)
 *     @main/services/agentQueryRunner (runAgentQuery → queryRouter)
 * If a real-boot test `vi.mock`s either, it RECREATES the exact mock-masking
 * blind spot the helper was built to eliminate: a semantic change to how the
 * executor assembles the request never reaches the (mocked) seam, so the test
 * stays green against an under-exercised graph — a silent false green. See
 * docs/plans/260609_agent-turn-executor-real-services-boot/PLAN.md (Stage 3, the
 * "(f) static guard" item).
 *
 * WHAT: find every test file that imports `bootRealAgentServices`, then FAIL
 * (zero tolerance — no baseline/ratchet) if it contains a `vi.mock(...)` of
 * either seam module. Robust to single/double quotes and to the
 * `vi.mock('...', factory)` form.
 *
 * SCOPE: only the two seam modules. NOT `@core/services/settingsStore` — the
 * helper injects settings via `setSettingsStoreAdapter(...)`, so a consumer
 * mocking settings is not the seam blind spot this guard protects.
 *
 * This mirrors the team's `check-*` grep-style guard convention (file-scoped
 * static check wired into validate:fast via run-validate-fast.ts), exactly like
 * scripts/check-executor-service-imports.ts. Cheap/static.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const HELPER_IMPORT_TOKEN = 'bootRealAgentServices';
const HELPER_REL = 'src/test-utils/bootRealAgentServices.ts';

/**
 * The provider-seam modules a real-boot test must NEVER mock. We match the
 * canonical specifier; the regex below also tolerates path variants by anchoring
 * on the trailing module segment.
 */
const SEAM_MODULES: readonly { readonly label: string; readonly specifierRe: RegExp }[] = [
  {
    label: '@core/rebelCore/queryRouter',
    // Allow alias/relative path variants that end in `rebelCore/queryRouter`.
    specifierRe: /(?:@core\/rebelCore\/queryRouter|(?:\.{1,2}\/)+(?:[\w./-]*\/)?rebelCore\/queryRouter)/,
  },
  {
    label: '@main/services/agentQueryRunner',
    specifierRe: /(?:@main\/services\/agentQueryRunner|(?:\.{1,2}\/)+(?:[\w./-]*\/)?services\/agentQueryRunner)/,
  },
];

/** Recursively collect `*.test.ts` / `*.integration.test.ts` files under a dir. */
function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...collectTestFiles(full));
    } else if (entry.isFile() && /\.(?:integration\.)?test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip `//` line comments and `/* *​/` block comments so a documented mention
 * of `vi.mock('@core/rebelCore/queryRouter')` in a header/comment (the real-boot
 * test files explain WHY they do NOT mock the seam) is not a false positive. We
 * only want ACTIVE source. This is a deliberately simple stripper (it does not
 * model strings containing comment-like text), which is sufficient: a `vi.mock`
 * call inside a string literal is not real code either.
 */
function stripComments(sourceText: string): string {
  return sourceText
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating `://` in URLs)
}

/**
 * Does `sourceText` mock the given seam module via `vi.mock('<spec>', ...)` OR
 * `vi.doMock('<spec>', ...)`? Robust to single/double quotes and an optional factory
 * argument. `vi.doMock` is common in this repo and would otherwise bypass the guard
 * (GPT final-review F2).
 */
function mocksSeam(sourceText: string, specifierRe: RegExp): boolean {
  // vi.(mock|doMock)( <quote> <specifier> <quote> ) — quote captured + back-referenced.
  // Whitespace tolerant; the specifier sub-pattern is embedded between the quotes.
  const re = new RegExp(
    String.raw`\bvi\s*\.\s*(?:mock|doMock)\s*\(\s*(['"])` + specifierRe.source + String.raw`\1`,
    'g',
  );
  return re.test(sourceText);
}

function main(): void {
  if (!fs.existsSync(SRC_ROOT)) {
    console.error(`❌ src/ not found at ${path.relative(REPO_ROOT, SRC_ROOT)}.`);
    process.exit(1);
  }

  // Match the helper only when it is the module SOURCE of a static or dynamic import —
  // `from '…/bootRealAgentServices'` or `import('…/bootRealAgentServices')` — not a mere
  // textual mention (e.g. a comment), which `text.includes(...)` would false-match
  // (GPT final-review F2).
  const HELPER_IMPORT_RE = new RegExp(
    String.raw`(?:from|import)\s*\(?\s*(['"])[^'"]*` + HELPER_IMPORT_TOKEN + String.raw`\1`,
  );
  const testFiles = collectTestFiles(SRC_ROOT);
  const helperUsers = testFiles.filter((f) =>
    HELPER_IMPORT_RE.test(stripComments(fs.readFileSync(f, 'utf8'))),
  );

  if (helperUsers.length === 0) {
    console.log(
      `✓ No test files import ${HELPER_IMPORT_TOKEN} yet — nothing to guard ` +
        `(guard will activate when real-boot tests exist).`,
    );
    return;
  }

  const violations: string[] = [];
  for (const file of helperUsers) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const seam of SEAM_MODULES) {
      if (mocksSeam(text, seam.specifierRe)) {
        violations.push(
          `   ${path.relative(REPO_ROOT, file)}\n` +
            `       mocks provider seam: ${seam.label}`,
        );
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `✓ ${helperUsers.length} real-boot test file(s) import ${HELPER_IMPORT_TOKEN}; ` +
        `none mock the provider seam (@core/rebelCore/queryRouter / ` +
        `@main/services/agentQueryRunner). The seam runs real — no mock-masking blind spot.`,
    );
    return;
  }

  console.error(
    [
      `❌ Real-boot test(s) mock the PROVIDER SEAM — this defeats bootRealAgentServices():`,
      ...violations,
      ``,
      `WHY THIS FAILS: bootRealAgentServices() exists to run the provider seam REAL`,
      `(only globalThis.fetch is stubbed) so the test asserts on the CAPTURED WIRE body`,
      `(capturedRequests[0].body) instead of reading call-args back from a vi.fn(). Mocking`,
      `@core/rebelCore/queryRouter or @main/services/agentQueryRunner recreates the exact`,
      `mock-masking blind spot the helper was built to eliminate: an executor↔service`,
      `semantic change never reaches the mocked seam, so the test stays green against an`,
      `under-exercised graph (a silent false green).`,
      ``,
      `FIX: remove the vi.mock of the seam module and assert on the captured wire instead`,
      `(see ${HELPER_REL} and the two existing *.realboot/*.smoke.integration.test.ts files).`,
      `If you genuinely do NOT want the real seam, do not import bootRealAgentServices().`,
    ].join('\n'),
  );
  process.exit(1);
}

main();
