/**
 * Regression fixture for `vitest.config.ts` fast-mode exclude list
 * (260419 prepush postmortem A3c).
 *
 * The 260419 bug had two halves — the husky hook regression (covered by
 * A3) and the config-side guard that translates `VITEST_FAST=1` into
 * `**\/*.integration.*` exclusion. If someone deletes the
 * `isFastMode ? ['**\/*.integration.*'] : []` entry from any project
 * config, fast-tier silently stops excluding integration tests.
 *
 * This test imports `vitest.config.ts` twice — once with `VITEST_FAST=1`
 * set, once without — and verifies the exclude list shape on every
 * project that runs Vitest tests with the fast-mode gate (desktop,
 * cloud-service, evals).
 *
 * @see ../../vitest.config.ts
 * @see docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md
 * @see docs/plans/260419_prepush_followups_roadmap.md (A3c)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const CONFIG_PATH = join(REPO_ROOT, 'vitest.config.ts');

interface ProjectConfig {
  test: {
    name?: string;
    exclude?: string[];
  };
}

interface VitestConfig {
  test: {
    projects: ProjectConfig[];
  };
}

/**
 * Re-import vitest.config.ts after toggling VITEST_FAST. Returns the
 * resolved config — top-level `defineConfig` reads `process.env` at
 * import time, so we use a cache-busting query suffix to force a fresh
 * evaluation.
 */
async function loadConfigWithFast(fastMode: boolean): Promise<VitestConfig> {
  const original = process.env.VITEST_FAST;
  if (fastMode) process.env.VITEST_FAST = '1';
  else delete process.env.VITEST_FAST;
  try {
    // Cache-bust to force re-evaluation of `isFastMode = ... === '1'`.
    const fileUrl = pathToFileURL(CONFIG_PATH).href + `?fast=${fastMode ? 1 : 0}&t=${Date.now()}`;
    const mod = (await import(fileUrl)) as { default: VitestConfig };
    return mod.default;
  } finally {
    if (original === undefined) delete process.env.VITEST_FAST;
    else process.env.VITEST_FAST = original;
  }
}

const FAST_EXCLUDE_PATTERN = '**/*.integration.*';

/** Project names that MUST exclude integration files under VITEST_FAST=1. */
const FAST_GATED_PROJECTS = ['desktop', 'cloud-service', 'evals'] as const;

afterEach(() => {
  // Defensive: ensure the env var isn't left set by a failed test branch.
  delete process.env.VITEST_FAST;
});

describe('vitest.config.ts fast-mode exclude list (A3c regression fixture)', () => {
  it('excludes **/*.integration.* on every fast-gated project under VITEST_FAST=1', async () => {
    const cfg = await loadConfigWithFast(true);
    const projects = cfg.test.projects;
    expect(projects.length).toBeGreaterThan(0);

    for (const projectName of FAST_GATED_PROJECTS) {
      const project = projects.find((p) => p.test.name === projectName);
      expect(project, `Project '${projectName}' is missing from vitest.config.ts`).toBeDefined();
      const exclude = project!.test.exclude ?? [];
      expect(
        exclude.includes(FAST_EXCLUDE_PATTERN),
        `Project '${projectName}' must exclude '${FAST_EXCLUDE_PATTERN}' under VITEST_FAST=1 (260419 regression class)`,
      ).toBe(true);
    }
  });

  it('does NOT exclude **/*.integration.* when VITEST_FAST is unset (full-tier semantics preserved)', async () => {
    const cfg = await loadConfigWithFast(false);
    const projects = cfg.test.projects;
    for (const projectName of FAST_GATED_PROJECTS) {
      const project = projects.find((p) => p.test.name === projectName);
      expect(project, `Project '${projectName}' is missing from vitest.config.ts`).toBeDefined();
      const exclude = project!.test.exclude ?? [];
      expect(
        exclude.includes(FAST_EXCLUDE_PATTERN),
        `Project '${projectName}' must NOT exclude '${FAST_EXCLUDE_PATTERN}' when VITEST_FAST is unset (otherwise CI loses integration coverage)`,
      ).toBe(false);
    }
  });
});
