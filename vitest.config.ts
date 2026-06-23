import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { RENDERER_SINGLETON_DEPS } from './scripts/renderer-singleton-deps.mjs';

const privateMindstoneBootstrapPath = path.resolve(__dirname, './private/mindstone/src/bootstrap.ts');
const privateMindstoneAliasTarget = existsSync(privateMindstoneBootstrapPath)
  ? path.resolve(__dirname, './private/mindstone/src')
  : path.resolve(__dirname, './src/main/oss/private-mindstone-stub');

const sharedAliases = {
  // '@' → src/renderer mirrors the production renderer build alias
  // (electron.vite.config.ts:139) and tsconfig.json:9. Without it, files that
  // import via `@/...` (e.g. features/nps/useNpsSurvey.ts, features/surveys/useSurvey.ts)
  // fail to resolve under vitest. Additive parity fix.
  '@': path.resolve(__dirname, './src/renderer'),
  '@core': path.resolve(__dirname, './src/core'),
  '@shared': path.resolve(__dirname, './src/shared'),
  '@rebel/shared': path.resolve(__dirname, './packages/shared/src'),
  '@rebel/cloud-client': path.resolve(__dirname, './cloud-client/src'),
  '@main': path.resolve(__dirname, './src/main'),
  '@private/mindstone': privateMindstoneAliasTarget,
  '@renderer': path.resolve(__dirname, './src/renderer'),
};
const isFastMode = process.env.VITEST_FAST === '1';

const sharedTestDefaults = {
  globals: true,
  environment: 'node' as const,
  testTimeout: 60000,
  hookTimeout: 60000,
  coverage: {
    provider: 'v8' as const,
    reporter: ['text-summary', 'json-summary', 'html'] as const,
    reportsDirectory: './coverage',
    include: ['src/**/*.ts', 'src/**/*.tsx', 'private/mindstone/src/**/*.ts', 'private/mindstone/src/**/*.tsx'],
    exclude: ['**/__tests__/**', '**/*.test.*', '**/test-utils/**'],
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...sharedTestDefaults,
          name: 'desktop',
          // Per-file isolation is load-bearing here, not incidental. The
          // single-boot IPC contract harness suite
          // (src/main/ipc/__tests__/ipcContractRoundTrip.harness.test.ts) boots
          // ambient services + the cloud-safe registrars ONCE at module top-level
          // and mutates global singletons (setHandlerRegistry, set*Factory). Its
          // leak-safety depends on each test FILE getting a fresh module context
          // so that boot state never bleeds into another file. This was Vitest's
          // default (`isolate: true`); we state it explicitly so a future config
          // change cannot silently turn it off and re-share module state across
          // files (Stage-6 review F2).
          isolate: true,
          include: [
            'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
            'private/mindstone/src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
            'mirror/**/*.{test,spec}.{ts,mts}',
            'eslint-rules/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}',
            'packages/shared/src/**/*.{test,spec}.{ts,mts}',
            'coding-agent-instructions/workflows/CHIEF_ENGINEER2/scripts/__tests__/**/*.{test,spec}.{ts,mts}',
            // All top-level scripts/__tests__ suites run in desktop via this glob.
            // This was ~117 individually-enumerated files; the enumeration
            // silently orphaned newly-added tests (no runner picked them up),
            // so the class is killed by construction here. The few
            // scripts/__tests__ suites that belong to the `mcp` project are
            // excluded by exact name below (exact names, not `mcp-*`:
            // mcp-release-parity.test.ts is a desktop suite).
            // See docs/plans/260610_testing-recs-drain (Stage 3).
            'scripts/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
            'scripts/sentry-autopilot/__tests__/**/*.{test,spec}.{ts,mts}',
            'scripts/lib/__tests__/**/*.{test,spec}.{ts,mts}',
            'scripts/backport/**/*.{test,spec}.{ts,mts}',
            'scripts/eval/__tests__/capture-keys.test.ts',
            'scripts/eval/__tests__/snapshot-live-settings.test.ts',
            'tests/e2e/helpers/__tests__/**/*.{test,spec}.{ts,mts}',
            'scripts/rebel-cli/__tests__/**/*.{test,spec}.{ts,mts}',
            'evals/__tests__/mcp-apps-trust-helpers.test.ts',
            'evals/__tests__/mcp-apps-trust-gate.test.ts',
            'cloud-client/src/__tests__/slack.test.ts',
            'cloud-client/src/__tests__/eventEnvelopeValidator.test.ts',
            'cloud-client/src/__tests__/cloudClient.cliSurface.test.ts',
            'cloud-client/src/__tests__/cloudClient.reconcile.test.ts',
            'cloud-client/src/components/__tests__/EventBridge.test.tsx',
            'tests/parity/**/*.{test,spec}.{ts,mts}',
            'tests/live-api/**/*.{test,spec}.{ts,mts}',
            'tests/connector-smoke/**/*.{test,spec}.{ts,mts}',
          ],
          exclude: [
            'node_modules',
            'dist',
            'out',
            'release',
            '.electron-vite',
            '**/build/**',
            '**/mcpHttp.integration*',
            // Perf-budget cases run in the dedicated single-threaded `perf` project
            // (see below) so parallel-load CPU contention does not flake them.
            '**/*.perf.test.ts',
            // These scripts/__tests__ suites belong to the `mcp` project (which
            // enumerates them in its own include list); excluded here so the
            // scripts/__tests__ glob above does not also run them under the
            // desktop project's setupFiles. Exact filenames on purpose — a
            // broad `mcp-*` pattern would wrongly drop desktop suites like
            // mcp-release-parity.test.ts.
            'scripts/__tests__/mcp-smoke.test.ts',
            'scripts/__tests__/electron-debug-server.contract.test.ts',
            'scripts/__tests__/mcp-catalog.test.ts',
            'scripts/__tests__/mcp-catalog-schema.test.ts',
            'scripts/__tests__/mcp-install-graph.test.ts',
            'scripts/__tests__/mcp-inbox-schema-parity.test.ts',
            'scripts/__tests__/mcp-inbox-date-schema.test.ts',
            'scripts/__tests__/mcp-inbox-list-truncation.test.ts',
            'scripts/__tests__/xero-token-caching.test.ts',
            'scripts/__tests__/rebel-oss-integration.test.ts',
            // CLI --exclude is unreliable in Vitest workspace mode; use VITEST_FAST=1 for fast-tier filtering.
            ...(isFastMode ? ['**/*.integration.*'] : []),
          ],
          // Desktop-only: strip ambient Claude creds so tests run credential-absent
          // like CI (see vitest.setup.desktop-creds.ts + 260607_oss-scrub-regression-class).
          setupFiles: ['./vitest.setup.ts', './vitest.setup.desktop-creds.ts'],
        },
        resolve: {
          alias: sharedAliases,
          // Dedupe React so that renderer tests importing from @rebel/cloud-client
          // do not pick up a second React copy from cloud-client/node_modules
          // (which would break the Rules of Hooks at test time).
          dedupe: [...RENDERER_SINGLETON_DEPS],
        },
      },
      {
        test: {
          ...sharedTestDefaults,
          name: 'cloud-service',
          include: ['cloud-service/src/**/*.{test,spec}.{ts,mts}'],
          exclude: ['node_modules', 'dist', '**/build/**', ...(isFastMode ? ['**/*.integration.*'] : [])],
          setupFiles: ['./vitest.setup.ts'],
          env: {
            // Cloud continuity tests default to mock agent turns for speed/determinism.
            // `npm run test:cloud:live` overrides this to exercise the real Anthropic API.
            REBEL_MOCK_AGENT_TURNS: process.env.REBEL_MOCK_AGENT_TURNS ?? '1',
          },
        },
        resolve: {
          alias: sharedAliases,
        },
      },
      {
        test: {
          ...sharedTestDefaults,
          name: 'mcp',
          include: [
            'resources/mcp/**/test-mcp.{test,spec}.ts',
            'resources/mcp/**/__tests__/**/*.{test,spec}.{ts,mts}',
            'scripts/__tests__/mcp-smoke.test.ts',
            'scripts/__tests__/electron-debug-server.contract.test.ts',
            'scripts/__tests__/mcp-catalog.test.ts',
            'scripts/__tests__/mcp-catalog-schema.test.ts',
            'scripts/__tests__/mcp-install-graph.test.ts',
            'scripts/__tests__/mcp-inbox-schema-parity.test.ts',
            'scripts/__tests__/mcp-inbox-date-schema.test.ts',
            'scripts/__tests__/mcp-inbox-list-truncation.test.ts',
            'scripts/__tests__/xero-token-caching.test.ts',
            'scripts/__tests__/rebel-oss-integration.test.ts',
            // Boots a real Super-MCP HTTP server on port 3333 (restart-race
            // coverage). Desktop-EXCLUDED (fixed port is unsafe under that
            // project's parallel forks); runs here serially with the other
            // mcp suites. Revived from dead-suite status by Stage 3 of
            // docs/plans/260610_testing-recs-drain.
            'src/main/services/__tests__/mcpHttp.integration.test.ts',
          ],
          exclude: [
            'node_modules',
            'dist',
            '**/build/**',
            'resources/mcp/granola/**',
            // Keep real-server integration suites out of the fast tier
            // (pre-push `VITEST_FAST=1 vitest related` would otherwise boot
            // Super-MCP on port 3333). Same fast-mode filter as the other projects.
            ...(isFastMode ? ['**/*.integration.*'] : []),
          ],
        },
        resolve: {
          alias: sharedAliases,
        },
      },
      {
        test: {
          ...sharedTestDefaults,
          name: 'evals',
          include: [
            'evals/__tests__/**/*.{test,spec}.{ts,mts}',
            'evals/sentry-autopilot/__tests__/**/*.{test,spec}.{ts,mts}',
            'evals/configs/__tests__/**/*.{test,spec}.{ts,mts}',
            'evals/lib/**/*.{test,spec}.{ts,mts}',
            'evals/messaging-adapter/__tests__/**/*.{test,spec}.{ts,mts}',
            'evals/mcp-twins/__tests__/**/*.{test,spec}.{ts,mts}',
          ],
          exclude: ['node_modules', 'dist', '**/build/**', ...(isFastMode ? ['**/*.integration.*'] : [])],
          setupFiles: ['./vitest.setup.ts'],
        },
        resolve: {
          alias: sharedAliases,
        },
      },
      {
        // Perf-budget cases run single-threaded in their own `vitest run` invocation
        // (npm run test:perf) so parallel-load CPU contention from the other projects'
        // forks does not flake the timing assertions. A single fork worker
        // (maxWorkers/minWorkers: 1) gives the perf cases a dedicated CPU; isolate:
        // true gives each file a clean module context. NOTE: Vitest 4 removed the
        // nested `poolOptions.forks.{maxForks,minForks}` form the plan named — the
        // documented replacement is the top-level `maxWorkers`/`minWorkers` here.
        test: {
          ...sharedTestDefaults,
          name: 'perf',
          include: ['**/*.perf.test.ts'],
          // Scope out *nested* node_modules too: the bare 'node_modules' glob only
          // matches the top-level dir, so vendored copies of diff.perf.test.ts under
          // cloud-client/web-companion/mobile node_modules would otherwise be swept in.
          exclude: ['**/node_modules/**', 'dist', '**/build/**'],
          pool: 'forks',
          maxWorkers: 1,
          // minWorkers is a no-op in Vitest 4; fileParallelism:false serialises perf
          // files within the project so timings stay stable as perf cases are added.
          fileParallelism: false,
          isolate: true,
          setupFiles: ['./vitest.setup.ts'],
        },
        resolve: {
          alias: sharedAliases,
          // Match the desktop project: dedupe renderer singletons so the relocated
          // engine perf cases resolve the same React/Fuse copies as their source.
          dedupe: [...RENDERER_SINGLETON_DEPS],
        },
      },
    ],
  },
});
