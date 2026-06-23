import { describe, it, expect } from 'vitest';
import { contributionChannels } from '../channels/contribution';
import { ipcContract, allChannels } from '../contracts';

/**
 * VAL-AUTH-009: All contribution IPC channels defined with Zod schemas.
 * VAL-AUTH-010: IPC contracts registered in contracts.ts.
 * VAL-STATE-007: IPC channels return correct data.
 *
 * Verifies:
 * - All contribution channel definitions exist with correct shape
 * - Channels are registered in ipcContract.contribution
 * - Channels are present in allChannels flat map
 * - Zod schemas parse valid/invalid payloads correctly
 */
describe('contribution IPC channels', () => {
  // ── VAL-AUTH-009: Contribution channels defined with Zod schemas ──

  const expectedChannels = [
    'contribution:submit',
    'contribution:submit-from-store',
    'contribution:submit-unified',
    'contribution:refresh-status',
    'contribution:list',
    'contribution:get-by-session',
    'contribution:update-local-state',
    'contribution:dismiss',
    'contribution:delete',
    'contribution:create-follow-up-context',
    'contribution:link-follow-up-session',
  ] as const;

  describe('channel definitions', () => {
    it('has all expected channels defined', () => {
      const channelCount = Object.keys(contributionChannels).length;
      expect(channelCount).toBeGreaterThanOrEqual(expectedChannels.length);
    });

    it.each(expectedChannels)('%s channel is defined with Zod schemas', (channelName) => {
      const channel = contributionChannels[channelName];
      expect(channel).toBeDefined();
      expect(channel.type).toBe('invoke');
      expect(channel.channel).toBe(channelName);
      expect(channel.request).toBeDefined();
      expect(channel.response).toBeDefined();
      // Verify schemas have parse methods (Zod)
      expect(typeof channel.request.safeParse).toBe('function');
      expect(typeof channel.response.safeParse).toBe('function');
    });
  });

  // ── VAL-AUTH-010: Channels registered in contracts.ts ───────────

  describe('contract registration', () => {
    it('contribution domain exists in ipcContract', () => {
      expect(ipcContract.contribution).toBeDefined();
      expect(ipcContract.contribution).toBe(contributionChannels);
    });

    it.each(expectedChannels)('%s is present in allChannels', (channelName) => {
      expect(allChannels[channelName]).toBeDefined();
      expect(allChannels[channelName].channel).toBe(channelName);
    });
  });

  // ── Zod schema validation ──────────────────────────────────────

  describe('Zod schema validation', () => {
    // ── Submit channel ────────────────────────────────────────────

    describe('contribution:submit', () => {
      it('accepts valid submit request', () => {
        const result = contributionChannels['contribution:submit'].request.safeParse({
          contributionId: 'contrib-abc',
        });
        expect(result.success).toBe(true);
      });

      it('rejects legacy payload fields (schema is strict)', () => {
        const result = contributionChannels['contribution:submit'].request.safeParse({
          contributionId: 'contrib-abc',
          connectorName: 'my-connector',
          files: [{ path: 'connectors/my-connector/src/index.ts', content: 'export {}' }],
          title: 'Add my-connector',
          body: 'Description',
        });
        expect(result.success).toBe(false);
      });

      it('rejects missing contributionId', () => {
        const result = contributionChannels['contribution:submit'].request.safeParse({
          connectorName: 'my-connector',
          files: [{ path: 'src/index.ts', content: '' }],
          title: 'Title',
          body: '',
        });
        expect(result.success).toBe(false);
      });

      it('validates success response with PR info', () => {
        const result = contributionChannels['contribution:submit'].response.safeParse({
          success: true,
          prUrl: 'https://github.com/org/repo/pull/42',
          prNumber: 42,
        });
        expect(result.success).toBe(true);
      });

      it('validates error response with reAuthRequired', () => {
        const result = contributionChannels['contribution:submit'].response.safeParse({
          success: false,
          error: 'Token expired',
          reAuthRequired: true,
        });
        expect(result.success).toBe(true);
      });
    });

    describe('contribution:submit-unified', () => {
      it('accepts valid submitUnified request', () => {
        const result = contributionChannels['contribution:submit-unified'].request.safeParse({
          contributionId: 'contrib-abc',
        });
        expect(result.success).toBe(true);
      });

      it('round-trips optional desired attribution fields in submitUnified request (Stage 3)', () => {
        const payload = {
          contributionId: 'contrib-abc',
          desiredAttributionMode: 'rebel-name',
          desiredAttributionName: 'Alex',
        } as const;
        const result = contributionChannels['contribution:submit-unified'].request.safeParse(payload);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual(payload);
        }
      });

      it('validates submitUnified success response', () => {
        const result = contributionChannels['contribution:submit-unified'].response.safeParse({
          success: true,
          prUrl: 'https://github.com/org/repo/pull/42',
          prNumber: 42,
        });
        expect(result.success).toBe(true);
      });

      it('validates submitUnified degraded success response', () => {
        const result = contributionChannels['contribution:submit-unified'].response.safeParse({
          success: true,
          prUrl: 'https://github.com/org/repo/pull/42',
          prNumber: 42,
          degraded: 'persistence-failed',
          duplicate: true,
        });
        expect(result.success).toBe(true);
      });

      it('accepts submitUnified success response with skippedDenylisted (Stage 3)', () => {
        const result = contributionChannels['contribution:submit-unified'].response.safeParse({
          success: true,
          prUrl: 'https://github.com/org/repo/pull/42',
          prNumber: 42,
          skippedDenylisted: ['.env', 'credentials.json'],
        });
        expect(result.success).toBe(true);
      });

      it('validates submitUnified error response', () => {
        const result = contributionChannels['contribution:submit-unified'].response.safeParse({
          success: false,
          error: {
            code: 'RATE_LIMIT',
            message: 'Too many submissions',
          },
        });
        expect(result.success).toBe(true);
      });
    });

    // ── Submit from store channel ─────────────────────────────────

    describe('contribution:submit-from-store', () => {
      it('accepts valid contributionId', () => {
        const result = contributionChannels['contribution:submit-from-store'].request.safeParse({
          contributionId: 'contrib-abc',
        });
        expect(result.success).toBe(true);
      });

      it('rejects empty contributionId', () => {
        const result = contributionChannels['contribution:submit-from-store'].request.safeParse({
          contributionId: '',
        });
        expect(result.success).toBe(false);
      });

      it('validates success response with PR info', () => {
        const result = contributionChannels['contribution:submit-from-store'].response.safeParse({
          success: true,
          prUrl: 'https://github.com/org/repo/pull/42',
          prNumber: 42,
        });
        expect(result.success).toBe(true);
      });

      it('validates error response with reAuthRequired', () => {
        const result = contributionChannels['contribution:submit-from-store'].response.safeParse({
          success: false,
          error: 'Token expired',
          reAuthRequired: true,
        });
        expect(result.success).toBe(true);
      });
    });

    // ── Refresh status channel ────────────────────────────────────

    describe('contribution:refresh-status', () => {
      it('accepts valid contributionId', () => {
        const result = contributionChannels['contribution:refresh-status'].request.safeParse({
          contributionId: 'contrib-123',
        });
        expect(result.success).toBe(true);
      });

      it('rejects empty contributionId', () => {
        const result = contributionChannels['contribution:refresh-status'].request.safeParse({
          contributionId: '',
        });
        expect(result.success).toBe(false);
      });

      it('validates success response with contribution', () => {
        const result = contributionChannels['contribution:refresh-status'].response.safeParse({
          success: true,
          contribution: {
            id: 'contrib-123',
            sessionId: 'session-abc',
            linkedSessionIds: ['session-abc'],
            connectorName: 'test',
            status: 'ci_pass',
            attributionMode: 'anonymous',
            acknowledgedEvents: [],
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T00:00:00Z',
          },
        });
        expect(result.success).toBe(true);
      });

      it('accepts relay failure response with typed code + message', () => {
        const result = contributionChannels['contribution:refresh-status'].response.safeParse({
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Sign-in required',
        });
        expect(result.success).toBe(true);
      });

      // The renderer toast hook uses this flag to render a "Reconnect
      // GitHub" action alongside the refresh-failure message. Both
      // fresh-expiry and legacy unmigrated-token paths set it server-side
      // (via GitHubReAuthRequiredError).
      it('accepts failure response with reAuthRequired:true', () => {
        const result = contributionChannels['contribution:refresh-status'].response.safeParse({
          success: false,
          error: 'Authentication expired. Please re-authenticate.',
          reAuthRequired: true,
        });
        expect(result.success).toBe(true);
      });
    });

    // ── Store read channels ───────────────────────────────────────

    describe('contribution:list', () => {
      it('accepts empty object request', () => {
        const result = contributionChannels['contribution:list'].request.safeParse({});
        expect(result.success).toBe(true);
      });

      it('validates response with empty contributions array', () => {
        const result = contributionChannels['contribution:list'].response.safeParse({
          contributions: [],
        });
        expect(result.success).toBe(true);
      });

      it('validates response with contribution records', () => {
        const result = contributionChannels['contribution:list'].response.safeParse({
          contributions: [{
            id: 'contrib-123',
            sessionId: 'session-abc',
            linkedSessionIds: ['session-abc'],
            connectorName: 'test-connector',
            status: 'draft',
            attributionMode: 'anonymous',
            acknowledgedEvents: [],
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T00:00:00Z',
          }],
        });
        expect(result.success).toBe(true);
      });

      it('rejects invalid contribution status in response', () => {
        const result = contributionChannels['contribution:list'].response.safeParse({
          contributions: [{
            id: 'contrib-123',
            sessionId: 'session-abc',
            connectorName: 'test-connector',
            status: 'invalid',
            attributionMode: 'anonymous',
            acknowledgedEvents: [],
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T00:00:00Z',
          }],
        });
        expect(result.success).toBe(false);
      });
    });

    describe('contribution:get-by-session', () => {
      it('accepts valid sessionId', () => {
        const result = contributionChannels['contribution:get-by-session'].request.safeParse({
          sessionId: 'session-abc-123',
        });
        expect(result.success).toBe(true);
      });

      it('rejects missing sessionId', () => {
        const result = contributionChannels['contribution:get-by-session'].request.safeParse({});
        expect(result.success).toBe(false);
      });

      it('rejects empty sessionId', () => {
        const result = contributionChannels['contribution:get-by-session'].request.safeParse({
          sessionId: '',
        });
        expect(result.success).toBe(false);
      });

      it('validates null contribution response', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: null,
        });
        expect(result.success).toBe(true);
      });

      it('validates response with contribution record', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: {
            id: 'contrib-123',
            sessionId: 'session-abc',
            linkedSessionIds: ['session-abc'],
            connectorName: 'test-connector',
            status: 'testing',
            attributionMode: 'github',
            attributionName: 'testuser',
            acknowledgedEvents: [
              { status: 'ci_pass', surface: 'banner', at: '2026-04-10T01:00:00Z' },
            ],
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T01:00:00Z',
          },
        });
        expect(result.success).toBe(true);
      });

      // Stage 3: lastTransitionError round-trips through the schema.
      it('accepts contribution record WITH lastTransitionError (Stage 3)', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: {
            id: 'contrib-123',
            sessionId: 'session-abc',
            linkedSessionIds: ['session-abc'],
            connectorName: 'test-connector',
            status: 'testing',
            attributionMode: 'github',
            acknowledgedEvents: [],
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T01:00:00Z',
            lastTransitionError: "Invalid transition: testing → draft. Current status is 'testing'; valid next states: ready_to_submit",
          },
        });
        expect(result.success).toBe(true);
      });

      it('accepts contribution record WITHOUT lastTransitionError (backward-compat)', () => {
        // Records predating Stage 3 won't have the field; Zod's .optional() must
        // let them pass. This is the backward-compat guarantee.
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: {
            id: 'contrib-123',
            sessionId: 'session-abc',
            linkedSessionIds: ['session-abc'],
            connectorName: 'test-connector',
            status: 'testing',
            attributionMode: 'github',
            acknowledgedEvents: [],
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T01:00:00Z',
          },
        });
        expect(result.success).toBe(true);
      });

      it('rejects non-string lastTransitionError (type-safety gate)', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: {
            id: 'contrib-123',
            sessionId: 'session-abc',
            connectorName: 'test-connector',
            status: 'testing',
            attributionMode: 'github',
            acknowledgedEvents: [],
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T01:00:00Z',
            lastTransitionError: { message: 'structured error' }, // wrong shape
          },
        });
        expect(result.success).toBe(false);
      });

      // Stage 4 (260426 foolproof contribution flow): the response carries an
      // optional `linkedContributionsCount?: number` for renderer multi-build
      // telemetry. Additive + backward-compat — pre-Stage-4 callers never see
      // the field. See docs/plans/260426_foolproof_contribution_flow_stage4.md.
      it('accepts response with linkedContributionsCount (Stage 4)', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: null,
          linkedContributionsCount: 2,
        });
        expect(result.success).toBe(true);
      });

      it('accepts response without linkedContributionsCount (backward-compat)', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: null,
        });
        expect(result.success).toBe(true);
      });

      it('rejects negative linkedContributionsCount', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: null,
          linkedContributionsCount: -1,
        });
        expect(result.success).toBe(false);
      });

      // Footer-question suppression follow-on (260427): the response carries an
      // optional `linkedContributionConnectorNames?: string[]` so the renderer
      // can suppress the `suggest_connector_setup` footer card once a build
      // exists for the same connector. Additive + backward-compat — callers
      // without the field still parse cleanly.
      it('accepts response with linkedContributionConnectorNames (260427 footer suppression)', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: null,
          linkedContributionsCount: 2,
          linkedContributionConnectorNames: ['Google Analytics', 'Slack'],
        });
        expect(result.success).toBe(true);
      });

      it('accepts response without linkedContributionConnectorNames (backward-compat)', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: null,
          linkedContributionsCount: 2,
        });
        expect(result.success).toBe(true);
      });

      it('accepts response with empty linkedContributionConnectorNames array', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: null,
          linkedContributionsCount: 0,
          linkedContributionConnectorNames: [],
        });
        expect(result.success).toBe(true);
      });

      it('rejects non-string entries inside linkedContributionConnectorNames', () => {
        const result = contributionChannels['contribution:get-by-session'].response.safeParse({
          contribution: null,
          linkedContributionsCount: 1,
          linkedContributionConnectorNames: [42],
        });
        expect(result.success).toBe(false);
      });
    });

    // ── Store write channels ──────────────────────────────────────

    describe('contribution:update-local-state', () => {
      it('accepts valid update request', () => {
        const result = contributionChannels['contribution:update-local-state'].request.safeParse({
          contributionId: 'contrib-abc',
          updates: {
            localServerPath: '/path/to/server',
            attributionMode: 'github',
          },
        });
        expect(result.success).toBe(true);
      });

      it('accepts update with status change', () => {
        const result = contributionChannels['contribution:update-local-state'].request.safeParse({
          contributionId: 'contrib-abc',
          updates: {
            status: 'testing',
          },
        });
        expect(result.success).toBe(true);
      });

      it('rejects invalid status in updates', () => {
        const result = contributionChannels['contribution:update-local-state'].request.safeParse({
          contributionId: 'contrib-abc',
          updates: {
            status: 'invalid_status',
          },
        });
        expect(result.success).toBe(false);
      });

      it('rejects empty contributionId', () => {
        const result = contributionChannels['contribution:update-local-state'].request.safeParse({
          contributionId: '',
          updates: {},
        });
        expect(result.success).toBe(false);
      });

      it('validates success response with contribution', () => {
        const result = contributionChannels['contribution:update-local-state'].response.safeParse({
          success: true,
          contribution: {
            id: 'contrib-123',
            sessionId: 'session-abc',
            linkedSessionIds: ['session-abc'],
            connectorName: 'test',
            status: 'testing',
            attributionMode: 'github',
            acknowledgedEvents: [],
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T00:00:00Z',
          },
        });
        expect(result.success).toBe(true);
      });

      // Stage 1.2 FU2 (260420 OSS MCP backend relay): attributionName
      // is nullable via the update channel. `null` is the sentinel that
      // tells the core store to delete the field (used when the user
      // retries with Anonymous after having set a Rebel name). A
      // non-null string still works for Rebel-name submissions.
      describe('attributionName null-sentinel (Stage 1.2 FU2)', () => {
        it('accepts updates with attributionName: null (field deletion sentinel)', () => {
          const result = contributionChannels['contribution:update-local-state'].request.safeParse({
            contributionId: 'contrib-abc',
            updates: {
              attributionMode: 'anonymous',
              attributionName: null,
            },
          });
          expect(result.success).toBe(true);
        });

        it('accepts updates with attributionName as a non-empty string (regression guard)', () => {
          const result = contributionChannels['contribution:update-local-state'].request.safeParse({
            contributionId: 'contrib-abc',
            updates: {
              attributionMode: 'rebel-name',
              attributionName: 'Alex',
            },
          });
          expect(result.success).toBe(true);
        });

        it('accepts updates that omit attributionName (leave-alone semantics)', () => {
          const result = contributionChannels['contribution:update-local-state'].request.safeParse({
            contributionId: 'contrib-abc',
            updates: {
              attributionMode: 'rebel-name',
            },
          });
          expect(result.success).toBe(true);
        });

        it('rejects non-string, non-null attributionName values', () => {
          const result = contributionChannels['contribution:update-local-state'].request.safeParse({
            contributionId: 'contrib-abc',
            updates: {
              attributionName: 42,
            },
          });
          expect(result.success).toBe(false);
        });
      });
    });

    describe('contribution:dismiss', () => {
      it('accepts valid dismiss request', () => {
        const result = contributionChannels['contribution:dismiss'].request.safeParse({
          contributionId: 'contrib-abc',
          status: 'approved',
          surface: 'banner',
        });
        expect(result.success).toBe(true);
      });

      it('accepts drawer surface', () => {
        const result = contributionChannels['contribution:dismiss'].request.safeParse({
          contributionId: 'contrib-abc',
          status: 'ci_pass',
          surface: 'drawer',
        });
        expect(result.success).toBe(true);
      });

      it('rejects invalid surface', () => {
        const result = contributionChannels['contribution:dismiss'].request.safeParse({
          contributionId: 'contrib-abc',
          status: 'approved',
          surface: 'invalid',
        });
        expect(result.success).toBe(false);
      });

      it('rejects missing status', () => {
        const result = contributionChannels['contribution:dismiss'].request.safeParse({
          contributionId: 'contrib-abc',
          surface: 'banner',
        });
        expect(result.success).toBe(false);
      });

      it('validates success response', () => {
        const result = contributionChannels['contribution:dismiss'].response.safeParse({
          success: true,
        });
        expect(result.success).toBe(true);
      });
    });

    // ── Follow-up session channels ────────────────────────────────

    describe('contribution:create-follow-up-context', () => {
      it('accepts valid contributionId', () => {
        const result = contributionChannels['contribution:create-follow-up-context'].request.safeParse({
          contributionId: 'contrib-123',
        });
        expect(result.success).toBe(true);
      });

      it('rejects empty contributionId', () => {
        const result = contributionChannels['contribution:create-follow-up-context'].request.safeParse({
          contributionId: '',
        });
        expect(result.success).toBe(false);
      });

      it('validates response with context', () => {
        const result = contributionChannels['contribution:create-follow-up-context'].response.safeParse({
          context: {
            prompt: 'The connector needs changes...',
            skillMention: 'extend-mcp-server/SKILL.md',
            contributionId: 'contrib-123',
            originalSessionId: 'session-abc',
            connectorName: 'my-connector',
          },
        });
        expect(result.success).toBe(true);
      });

      it('validates null context response', () => {
        const result = contributionChannels['contribution:create-follow-up-context'].response.safeParse({
          context: null,
        });
        expect(result.success).toBe(true);
      });
    });

    describe('contribution:link-follow-up-session', () => {
      it('accepts valid request', () => {
        const result = contributionChannels['contribution:link-follow-up-session'].request.safeParse({
          contributionId: 'contrib-123',
          followUpSessionId: 'session-followup-1',
        });
        expect(result.success).toBe(true);
      });

      it('rejects empty contributionId', () => {
        const result = contributionChannels['contribution:link-follow-up-session'].request.safeParse({
          contributionId: '',
          followUpSessionId: 'session-followup-1',
        });
        expect(result.success).toBe(false);
      });

      it('rejects empty followUpSessionId', () => {
        const result = contributionChannels['contribution:link-follow-up-session'].request.safeParse({
          contributionId: 'contrib-123',
          followUpSessionId: '',
        });
        expect(result.success).toBe(false);
      });

      it('validates success response', () => {
        const result = contributionChannels['contribution:link-follow-up-session'].response.safeParse({
          success: true,
        });
        expect(result.success).toBe(true);
      });

      it('validates error response', () => {
        const result = contributionChannels['contribution:link-follow-up-session'].response.safeParse({
          success: false,
          error: 'Contribution not found',
        });
        expect(result.success).toBe(true);
      });
    });
  });
});
