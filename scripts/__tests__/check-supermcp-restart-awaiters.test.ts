import { describe, expect, it } from 'vitest';

import {
  checkSuperMcpRestartAwaiters,
  DEFAULT_SUPER_MCP_RESTART_AWAITER_ALLOWLIST,
  formatGuardResult,
  type SourceInput,
  type SuperMcpRestartAwaiterAllowlistEntry,
} from '../check-supermcp-restart-awaiters';
import { STEPS } from '../run-validate-fast';

const repoRoot = process.cwd();

function runSynthetic(
  allowlist: readonly SuperMcpRestartAwaiterAllowlistEntry[],
  sourceInputs: readonly SourceInput[],
) {
  return checkSuperMcpRestartAwaiters({
    repoRoot,
    allowlist,
    sourceInputs,
  });
}

describe('check-supermcp-restart-awaiters', () => {
  it('passes for the real repo tree with the four deliberate awaiters', () => {
    const result = checkSuperMcpRestartAwaiters({ repoRoot });

    expect(result.failed).toBe(false);
    expect(result.failures).toEqual([]);
    expect(formatGuardResult(result)).toContain('Super-MCP restart awaiter guard passed');
    expect(result.occurrences.filter((occurrence) => occurrence.matchedAllowlistIndex !== null)).toHaveLength(4);
  });

  it('fails when a new unallowlisted await appears in user-facing IPC', () => {
    const result = runSynthetic(DEFAULT_SUPER_MCP_RESTART_AWAITER_ALLOWLIST, [
      {
        filePath: 'src/main/ipc/syntheticHandlers.ts',
        sourceText: `
          import { restartSuperMcpForConfigChangeAndAwaitExecution } from '../services/mcpService';

          export async function connectNewAccount(configPath: string) {
            await restartSuperMcpForConfigChangeAndAwaitExecution(configPath, 'synthetic-connect');
            return { ok: true };
          }
        `,
      },
    ]);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unallowlisted_awaiter',
          filePath: 'src/main/ipc/syntheticHandlers.ts',
          detail: expect.stringContaining('restartSuperMcpForConfigChangeAndAwaitExecution'),
        }),
      ]),
    );
    expect(formatGuardResult(result)).toContain(POSTMORTEM_SNIPPET);
  });

  it('fails when a new unallowlisted promise-chain awaiter appears', () => {
    const result = runSynthetic(DEFAULT_SUPER_MCP_RESTART_AWAITER_ALLOWLIST, [
      {
        filePath: 'src/main/ipc/syntheticHandlers.ts',
        sourceText: `
          import { reconfigureSuperMcpWithCacheRefreshAndAwaitExecution } from '../services/mcpService';

          export function handleOAuthReturn(configPath: string) {
            reconfigureSuperMcpWithCacheRefreshAndAwaitExecution(configPath, { context: 'synthetic-oauth' })
              .then(() => console.log('done'));
          }
        `,
      },
    ]);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unallowlisted_awaiter',
          detail: expect.stringContaining('promise-chain'),
        }),
      ]),
    );
  });

  it('fails when an allowlist entry no longer matches any live occurrence', () => {
    const staleAllowlist: SuperMcpRestartAwaiterAllowlistEntry[] = [
      ...DEFAULT_SUPER_MCP_RESTART_AWAITER_ALLOWLIST,
      {
        filePath: 'src/main/ipc/removedHandler.ts',
        marker: 'removedAwaiter',
        kind: 'await',
        rationale: 'Synthetic stale entry for anti-rot testing.',
      },
    ];

    const result = checkSuperMcpRestartAwaiters({
      repoRoot,
      allowlist: staleAllowlist,
    });

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'stale_allowlist_entry',
          filePath: 'src/main/ipc/removedHandler.ts',
          detail: expect.stringContaining('removedAwaiter'),
        }),
      ]),
    );
  });

  it('does not flag awaits inside the AndAwaitExecution implementation seam', () => {
    const result = runSynthetic([], [
      {
        filePath: 'src/main/services/mcpService.ts',
        sourceText: `
          export const reconfigureSuperMcpWithCacheRefreshAndAwaitExecution = async (configPath: string) => {
            await superMcpHttpManager.requestRestartForConfigChangeAndAwaitExecution({ configPath, context: 'x' });
          };
          export const restartSuperMcpForConfigChangeAndAwaitExecution = async (configPath: string) => {
            await reconfigureSuperMcpWithCacheRefreshAndAwaitExecution(configPath);
          };
        `,
      },
    ]);

    expect(result.failed).toBe(false);
    expect(result.occurrences).toEqual([]);
  });

  it('is wired into validate:fast next to the sibling guards added this run', () => {
    const stepNames = STEPS.map((step) => step.name);
    const bodyModelIndex = stepNames.indexOf('check-agent-tool-body-model-source');
    const awaiterIndex = stepNames.indexOf('check-supermcp-restart-awaiters');

    expect(awaiterIndex).toBeGreaterThan(bodyModelIndex);
    expect(STEPS[awaiterIndex]?.command).toBe(
      'npx tsx scripts/check-supermcp-restart-awaiters.ts',
    );
  });
});

const POSTMORTEM_SNIPPET = '260610_connector_disconnect_deferred_restart_ipc_hang_postmortem';
