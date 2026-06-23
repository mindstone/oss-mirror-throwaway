/**
 * Contract test — "the paths the build-custom-mcp-server skill tells agents
 * to Write must actually be writable by the Write tool."
 *
 * Background: on 2026-04-20 a user hit an impasse where the skill mandated
 * `~/mcp-servers/<api-name>-mcp/…` paths but the Write tool rejected them
 * for being outside the workspace root. See
 * `docs-private/postmortems/260420_mcp_write_sandbox_mismatch_postmortem.md`.
 *
 * This test pins the invariant by PARSING the bundled SKILL.md for every
 * `~/mcp-servers/…` path literal and asserting that
 * `resolveToolPath(…, {tool: 'Write'})` accepts each one. If the skill ever
 * drifts to a path the tool can't reach (new file, renamed dir, new phase),
 * the build fails — no manual list to keep in sync.
 *
 * Template placeholders like `<api-name>-mcp` are substituted with a
 * representative value (`foo-mcp`) before resolution.
 *
 * A small {@link IGNORED_SKILL_PATHS} set covers lines that mention
 * `~/mcp-servers/…` in non-write contexts (e.g. shell `cd` commands, prose
 * directory references).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveToolPath } from '../toolPathResolver';

const FAKE_HOME = '/Users/tester';
const FAKE_CWD = '/Users/tester/Documents/Rebel';
const PLACEHOLDER_SUBSTITUTE = 'foo-mcp';

const SKILL_MD_PATH = path.resolve(
  __dirname,
  '..', '..', '..', '..',
  'rebel-system',
  'skills',
  'coding',
  'build-custom-mcp-server',
  'SKILL.md',
);

const EXTEND_SKILL_MD_PATH = path.resolve(
  __dirname,
  '..', '..', '..', '..',
  'rebel-system',
  'skills',
  'coding',
  'extend-mcp-server',
  'SKILL.md',
);

/**
 * Paths the skill mentions that are NOT Write targets (e.g. shown as
 * directory references in shell examples, or as directories themselves
 * rather than files). Adding a path here is an explicit opt-out — it must
 * be reviewed when the skill is changed.
 */
const IGNORED_SKILL_PATHS: ReadonlySet<string> = new Set([
  // Directory references, not files the Write tool would target:
  '~/mcp-servers/',
  '~/mcp-servers',
  '~/mcp-servers/<api-name>-mcp',
  '~/mcp-servers/<api-name>-mcp/',
  '~/mcp-servers/<api-name>-mcp/src',
  '~/mcp-servers/<api-name>-mcp/docs',
  '~/mcp-servers/<api-name>-mcp/dist',
]);

function substitute(template: string): string {
  return template.replace(/<api-name>-mcp/g, PLACEHOLDER_SUBSTITUTE);
}

function isPlausibleFilePath(p: string): boolean {
  // A file path has a dot-extension in its final segment, e.g. `.ts`, `.json`.
  // We keep extensionless uppercase files (README, LICENSE) if explicitly named.
  const last = p.split('/').pop() ?? '';
  return /\.[a-zA-Z0-9]+$/.test(last) || /^(README|LICENSE|CHANGELOG)$/.test(last);
}

function extractMcpServerPaths(markdown: string): string[] {
  // Matches `~/mcp-servers/…` sequences — stops at whitespace, backtick,
  // paren, bracket, comma, or quote.
  const regex = /~\/mcp-servers\/[^\s`)\],'"“”]+/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = regex.exec(markdown))) {
    // Trim trailing punctuation that leaks in (period, colon, semicolon).
    const p = m[0].replace(/[.,:;]+$/, '');
    found.add(p);
  }
  return Array.from(found);
}

const skillMarkdown = fs.readFileSync(SKILL_MD_PATH, 'utf8');
const allPaths = extractMcpServerPaths(skillMarkdown);
const writePathCandidates = allPaths
  .filter((p) => !IGNORED_SKILL_PATHS.has(p))
  .filter(isPlausibleFilePath);

describe('build-custom-mcp-server skill path contract', () => {
  it('SKILL.md exists and parses non-empty', () => {
    expect(skillMarkdown.length).toBeGreaterThan(1000);
    expect(allPaths.length).toBeGreaterThan(0);
  });

  it('finds at least the canonical scaffold files in SKILL.md', () => {
    // Sanity check — the skill must mention the scaffold files. If this
    // fails, either the skill was rewritten (review the changes!) or the
    // regex broke.
    const joined = writePathCandidates.join('\n');
    expect(joined).toMatch(/package\.json/);
    expect(joined).toMatch(/tsconfig\.json/);
    expect(joined).toMatch(/src\/index\.ts/);
  });

  for (const rawPath of writePathCandidates) {
    it(`Write tool accepts skill-mandated path: ${rawPath}`, () => {
      const concretePath = substitute(rawPath);
      const result = resolveToolPath(concretePath, {
        cwd: FAKE_CWD,
        homePath: FAKE_HOME,
        tool: 'Write',
      });
      if (!result.ok) {
        throw new Error(
          `Write tool rejected skill-mandated path "${rawPath}" ` +
            `(resolved to "${concretePath}"): ${result.error} (reason=${result.reason}). ` +
            'Options: (a) update SKILL.md to use a reachable path, (b) extend ' +
            'src/core/rebelCore/toolPathResolver.ts allowlist, or (c) add this ' +
            'path to IGNORED_SKILL_PATHS if it is a directory/prose reference.',
        );
      }
      expect(result.ok).toBe(true);
    });
  }

  it('starter-template files still exist on disk', () => {
    // Signal smell-test: if the skill mentions a starter-template file that
    // no longer exists on disk, either the skill or the template has drifted.
    const templateRoot = path.resolve(
      __dirname,
      '..', '..', '..', '..',
      'rebel-system',
      'skills',
      'coding',
      'build-custom-mcp-server',
      'references',
      'starter-template',
    );
    // Paths in SKILL_MANDATED_WRITE_PATHS that correspond to starter-template
    // files (project-name-agnostic suffix):
    const expectedTemplateFiles = [
      'package.json',
      'tsconfig.json',
      '.gitignore',
      '.env.example',
      'src/index.ts',
      'src/logger.ts',
    ];
    for (const rel of expectedTemplateFiles) {
      const abs = path.join(templateRoot, rel);
      expect(
        fs.existsSync(abs),
        `Starter template file missing: ${abs}. Update SKILL_MANDATED_WRITE_PATHS or restore the template.`,
      ).toBe(true);
    }
  });
});

/**
 * Contract test for the `extend-mcp-server` skill, which writes to a
 * different path shape than build-custom: a cloned OSS repo at
 * `~/mcp-servers/mcp-servers-repo/` with connector work scoped to
 * `connectors/<name>/`.
 *
 * Unlike build-custom, extend-skill Phase 4 does not enumerate concrete
 * `~/mcp-servers/...` file literals (the skill delegates implementation to
 * the Software Engineer workflow with a connector-relative brief). So we
 * pin the invariant with a representative set of paths the skill's Phase 4
 * and Phase 6.1 require — any of which failing would break the skill.
 */
const EXTEND_SKILL_MANDATED_WRITE_PATHS: readonly string[] = [
  // Phase 4 — Software Engineer workflow writes code/tests/docs:
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/docs/extension-plan.md',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/docs/notes.md',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/src/index.ts',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/src/tools/newTool.ts',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/src/tools/index.ts',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/src/server.ts',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/test/smoke.test.ts',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/test/newTool.test.ts',
  // Phase 6.1 — commit-able metadata updates:
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/package.json',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/tsconfig.json',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/README.md',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/.env.example',
  '~/mcp-servers/mcp-servers-repo/connectors/<name>/catalog-entry.json',
];

describe('extend-mcp-server skill path contract', () => {
  const skillExists = fs.existsSync(EXTEND_SKILL_MD_PATH);

  it('extend-mcp-server SKILL.md exists', () => {
    expect(skillExists).toBe(true);
  });

  for (const rawPath of EXTEND_SKILL_MANDATED_WRITE_PATHS) {
    it(`Write tool accepts extend-skill path: ${rawPath}`, () => {
      const concretePath = rawPath.replace(/<name>/g, 'slack');
      const result = resolveToolPath(concretePath, {
        cwd: FAKE_CWD,
        homePath: FAKE_HOME,
        tool: 'Write',
      });
      if (!result.ok) {
        throw new Error(
          `Write tool rejected extend-skill path "${rawPath}" ` +
            `(resolved to "${concretePath}"): ${result.error} (reason=${result.reason}). ` +
            'Either update the skill to use a reachable path or update ' +
            'src/core/rebelCore/toolPathResolver.ts (managed-repo allowlist).',
        );
      }
      expect(result.ok).toBe(true);
    });
  }

  it('rejects writes outside connectors/<name>/ (e.g. managed-repo root files)', () => {
    // Defensive — the extend skill must NOT let agents modify the repo root.
    const r = resolveToolPath(
      '~/mcp-servers/mcp-servers-repo/README.md',
      { cwd: FAKE_CWD, homePath: FAKE_HOME, tool: 'Write' },
    );
    expect(r.ok).toBe(false);
  });

  it('rejects writes into .github/ workflows at the repo root', () => {
    const r = resolveToolPath(
      '~/mcp-servers/mcp-servers-repo/.github/workflows/ci.yml',
      { cwd: FAKE_CWD, homePath: FAKE_HOME, tool: 'Write' },
    );
    expect(r.ok).toBe(false);
  });
});
