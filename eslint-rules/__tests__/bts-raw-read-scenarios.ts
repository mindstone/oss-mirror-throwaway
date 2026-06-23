// Shared scenario fixtures for the S4.5 `bts-flow-shape/no-raw-bts-model-read`
// rule, consumed by BOTH:
//   - scripts/check-bts-prefix-decoder-rule.ts  (the fast minimal-config self-test)
//   - eslint-rules/__tests__/bts-raw-read-config-drift.test.js  (the verdict-parity proof)
//
// Single source for the snippets so the drift test runs the EXACT scenarios the
// self-test runs through BOTH the minimal config and the full production config,
// proving the two produce identical per-scenario verdicts (not merely matching
// surfaces). Side-effect-free, import-cheap (no ESLint engine).

export type BtsRawReadScenario = {
  readonly name: string;
  readonly filePath: string;
  readonly code: string;
  readonly expected: 'must_error' | 'must_pass';
};

export const BTS_RAW_READ_SCENARIOS: readonly BtsRawReadScenario[] = [
  {
    name: 'bypass read in non-exempt path',
    filePath: 'src/main/services/new-leaker.ts',
    code: `
      export function leak(settings: { behindTheScenesModel?: string }) {
        return settings.behindTheScenesModel;
      }
    `,
    expected: 'must_error',
  },
  {
    name: 'destructured bypass in non-exempt path',
    filePath: 'src/main/services/new-destructure-leaker.ts',
    code: `
      export function leakDestructured(settings: { behindTheScenesOverrides?: Record<string, string> }) {
        const { behindTheScenesOverrides } = settings;
        return behindTheScenesOverrides;
      }
    `,
    expected: 'must_error',
  },
  {
    name: 'helper usage in non-exempt path',
    filePath: 'src/main/services/new-safe-reader.ts',
    code: `
      import { resolveBtsModel } from '@shared/utils/btsModelResolver';

      export function safe(settings: unknown) {
        return resolveBtsModel(settings as Parameters<typeof resolveBtsModel>[0], 'memory');
      }
    `,
    expected: 'must_pass',
  },
  {
    name: 'allowlisted file path remains exempt',
    filePath: 'src/main/services/authService.ts',
    code: `
      export function exempt(settings: { behindTheScenesModel?: string }) {
        return settings.behindTheScenesModel;
      }
    `,
    expected: 'must_pass',
  },
];
