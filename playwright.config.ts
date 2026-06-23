import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Absolute path to the built Rebel browser extension — Playwright Chromium
 * loads this via `--load-extension` + `--disable-extensions-except` in the
 * `bridge-browser` project. The build script (scripts/build-browser-extension.ts)
 * must have run before the bridge-browser project starts.
 */
const BRIDGE_BROWSER_EXTENSION_DIR = path.resolve(
  __dirname,
  'packages/browser-extension/dist',
);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: {
    timeout: 15_000
  },
  // Global setup/teardown for parallel test execution
  // See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 7)
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  // Enable parallel execution - each worker gets isolated userData and Super-MCP port
  // CI: Use 1 worker to prevent cross-worker interference from orphaned processes
  // (Super-MCP spawned with detached:true can contaminate other workers' IPC)
  // Local: 2 workers (configurable via E2E_WORKERS env var). Reduced from 4 to avoid
  // CPU/GPU contention that stretches timing windows — see WHY_E2E_TESTS_ARE_HARD_TO_FIX.md Entry #22
  workers: process.env.CI ? 1 : (parseInt(process.env.E2E_WORKERS || '') || 2),
  // Bounded retry on CI (1, not 2): kills the "1% per-spec flake → ~30% job-fail"
  // arithmetic of a monolithic ~115-spec × 1-worker job, while a real regression
  // (fails BOTH attempts) still reds the run fastest. The old "can't retry —
  // Electron state is hard to reset" comment was stale: the harness now isolates
  // userData per launch (fs.mkdtempSync, test-utils.ts) and triple-nets orphan
  // reaping (attached Super-MCP in test mode + safeCloseApp pgrep sweep + global
  // cleanupOrphanedTestProcesses), so a relaunched retry starts clean.
  // retries:1 is a NET, not a cure — paired with the flaky-set observability that
  // surfaces every retried-green spec (scripts/ci/summarize-e2e-results.ts) so red
  // means something. It shrinks as Stage-2 root-cause fixes land. Local stays 0
  // (fail fast). See docs/plans/260617_deflake-ci-for-blocking-gates/PLAN.md
  // (Stage 1) + docs/project/CI_PIPELINE.md § "E2E flake policy & gate-readiness".
  retries: process.env.CI ? 1 : 0,
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  // 'json' alongside 'list' always produces a machine-readable per-spec report
  // (flaky/expected/unexpected/skipped) for the flake-observability summary step.
  // Honour PLAYWRIGHT_JSON_OUTPUT_NAME when a job sets it (the chronic-staleness
  // gate already uses this env); otherwise default a stable path. Note: when a job
  // passes `--reporter=list,json` on the CLI it replaces this config array, so the
  // `outputFile` below isn't used there — but Playwright still resolves the JSON
  // path from PLAYWRIGHT_JSON_OUTPUT_NAME, so the file lands either way. The
  // `outputFile` default covers the config path (local dev, the perf step).
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME || 'e2e-results.json' }],
  ],

  // Project separation: E2E tests vs screenshot capture vs performance tests
  // - 'e2e' project runs all tests EXCEPT screenshots and perf (default for `npm run test:e2e`)
  // - 'screenshots' project runs ONLY screenshot capture (use `npm run capture:screenshots`)
  // - 'perf' project runs ONLY performance regression tests (use `npm run test:e2e:perf`)
  projects: [
    {
      name: 'e2e',
      // Per-project outputDir so concurrent / sequential runs (e.g. CI runs
      // `test:e2e` then `test:e2e:perf` in the same job) don't wipe each
      // other's failure artifacts. Playwright clears outputDir at the start
      // of every run; sharing one folder destroyed our only diagnostic
      // evidence for E2E failures.
      outputDir: 'test-results/e2e',
      testIgnore: [
        '**/screenshots.spec.ts',
        '**/perf-*.spec.ts',
        // Unit tests for helper modules live under tests/e2e/helpers/__tests__
        // and are executed by Vitest, not Playwright.
        '**/helpers/__tests__/**',
        // Bridge-browser scenarios own their own headful Chromium project and
        // spin up real HTTP/WS servers; they don't fit the Electron-app-per-test
        // harness the `e2e` project provides. Run them via
        // `npm run test:e2e:bridge-browser` (Stage 9 of the App Bridge plan).
        '**/app-bridge/**',
      ]
    },
    {
      name: 'screenshots',
      outputDir: 'test-results/screenshots',
      testMatch: ['**/screenshots.spec.ts']
    },
    {
      name: 'perf',
      outputDir: 'test-results/perf',
      testMatch: ['**/perf-*.spec.ts']
    },
    /**
     * bridge-browser — Rebel browser extension E2E (Stage 9 of the App
     * Bridge plan). Chromium-only + headful is mandatory for MV3
     * extensions; tests skip gracefully on Linux without `CI_XVFB=1`.
     * Each scenario binds its own ephemeral bridge and pair flow, so
     * we stay at 1 worker to avoid port races.
     *
     * See docs/plans/260418_rebel_app_bridge_and_browser_extension.md §Stage 9.
     */
    {
      name: 'bridge-browser',
      outputDir: 'test-results/bridge-browser',
      testMatch: ['**/app-bridge/**/*.spec.ts'],
      workers: 1,
      use: {
        headless: false,
        launchOptions: {
          args: [
            `--disable-extensions-except=${BRIDGE_BROWSER_EXTENSION_DIR}`,
            `--load-extension=${BRIDGE_BROWSER_EXTENSION_DIR}`,
            '--no-first-run',
            '--no-default-browser-check',
          ],
        },
      },
    }
  ]
});
