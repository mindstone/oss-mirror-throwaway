import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const rule = require('../no-raw-turn-liveness-scalars.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

ruleTester.run('no-raw-turn-liveness-scalars', rule, {
  valid: [
    {
      name: 'allows projection-owned scalar reads',
      filename: '/repo/src/main/services/cloud/cloudRouterHelpers.ts',
      code: `
        const scalars = toPersistedBusyScalars(deriveTurnLiveness(eventsByTurn, Date.now()));
        const session = {
          id: 's1',
          title: 'x',
          updatedAt: Date.now(),
          messages: [],
          eventsByTurn: {},
          resolvedAt: null,
          isBusy: scalars.isBusy,
          activeTurnId: scalars.activeTurnId,
        };
        void session;
      `,
    },
    {
      name: 'allows non-session objects',
      filename: '/repo/src/main/services/cloud/cloudRouterHelpers.ts',
      code: `
        const runtimeFlags = {
          isBusy: true,
          label: 'ui-only',
        };
        void runtimeFlags;
      `,
    },
  ],
  invalid: [
    {
      name: 'flags raw session object scalar literals',
      filename: '/repo/src/main/services/cloud/cloudRouterHelpers.ts',
      code: `
        const session = {
          id: 's1',
          title: 'x',
          updatedAt: Date.now(),
          messages: [],
          eventsByTurn: {},
          resolvedAt: null,
          isBusy: true,
          activeTurnId: 'turn-1',
        };
        void session;
      `,
      errors: [
        { messageId: 'noRawScalarWrite', data: { key: 'isBusy' } },
        { messageId: 'noRawScalarWrite', data: { key: 'activeTurnId' } },
      ],
    },
    {
      name: 'flags raw owner-file summary writes (no whole-file exemption)',
      filename: '/repo/src/renderer/features/agent-session/store/sessionStore.ts',
      code: `
        const summary = {
          id: 's1',
          title: 'x',
          updatedAt: Date.now(),
          preview: '',
          messageCount: 0,
          usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
          isBusy: true,
          activeTurnId: 'turn-1',
        };
        void summary;
      `,
      errors: [
        { messageId: 'noRawScalarWrite', data: { key: 'isBusy' } },
        { messageId: 'noRawScalarWrite', data: { key: 'activeTurnId' } },
      ],
    },
    {
      name: 'flags member assignment writes',
      filename: '/repo/src/main/services/cloud/cloudRouterHelpers.ts',
      code: `
        function clear(session: { isBusy: boolean; activeTurnId: string | null }): void {
          session.isBusy = false;
          session.activeTurnId = null;
        }
      `,
      errors: [
        { messageId: 'noRawScalarWrite', data: { key: 'isBusy' } },
        { messageId: 'noRawScalarWrite', data: { key: 'activeTurnId' } },
      ],
    },
  ],
});

describe('rebel-liveness-scalars/no-raw-turn-liveness-scalars', () => {
  it('exposes allowlist metadata for regression tests', () => {
    expect(Array.isArray(rule.ALLOWLIST_PATH_SEGMENTS)).toBe(true);
    expect(rule.ALLOWLIST_PATH_SEGMENTS.length).toBeGreaterThan(0);
  });

  it('does not whole-file allowlist sessionStore', () => {
    expect(
      rule.ALLOWLIST_PATH_SEGMENTS.some((segment) => segment.includes('/sessionStore.ts')),
    ).toBe(false);
  });
});
