import { describe, expect, it } from 'vitest';

import {
  checkSuperMcpSingleStartupPath,
  formatGuardResult,
  type SourceInput,
  type SuperMcpSingleStartupPathAllowlistEntry,
} from '../check-supermcp-single-startup-path';
import { STEPS } from '../run-validate-fast';

const repoRoot = process.cwd();

const managerSource: SourceInput = {
  filePath: 'src/core/services/superMcpHttpManager.ts',
  sourceText: `
    export class SuperMcpHttpManager {
      public async start(): Promise<void> {}
      public async startWithRetries(): Promise<void> {
        await this.start();
      }
    }

    export const superMcpHttpManager = new SuperMcpHttpManager();

    export async function startSuperMcpWithRetries(): Promise<void> {
      return superMcpHttpManager.startWithRetries();
    }
  `,
};

function runSynthetic(
  sourceInputs: readonly SourceInput[],
  allowlist: readonly SuperMcpSingleStartupPathAllowlistEntry[] = [],
) {
  return checkSuperMcpSingleStartupPath({
    repoRoot,
    allowlist,
    sourceInputs: [managerSource, ...sourceInputs],
  });
}

describe('check-supermcp-single-startup-path', () => {
  it('passes for the real repo tree with zero external raw starts', () => {
    const result = checkSuperMcpSingleStartupPath({ repoRoot });

    expect(result.failed).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.occurrences).toEqual([]);
    expect(formatGuardResult(result)).toContain('External raw superMcpHttpManager.start(...) call sites: 0');
  });

  it('fails when an external named import calls start directly', () => {
    const result = runSynthetic([
      {
        filePath: 'src/main/services/syntheticBootstrap.ts',
        sourceText: `
          import { superMcpHttpManager } from '@core/services/superMcpHttpManager';

          export async function bootSuperMcp(): Promise<void> {
            await superMcpHttpManager.start();
          }
        `,
      },
    ]);

    expect(result.failed).toBe(true);
    expect(result.occurrences).toHaveLength(1);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unallowlisted_external_start',
          filePath: 'src/main/services/syntheticBootstrap.ts',
          detail: expect.stringContaining('superMcpHttpManager.start(...)'),
        }),
      ]),
    );
    expect(formatGuardResult(result)).toContain('startSuperMcpWithRetries');
  });

  it('passes when an external raw start is explicitly allowlisted by marker', () => {
    const result = runSynthetic(
      [
        {
          filePath: 'src/main/services/syntheticBootstrap.ts',
          sourceText: `
            import { superMcpHttpManager } from '@core/services/superMcpHttpManager';

            export async function bootSuperMcp(): Promise<void> {
              await superMcpHttpManager.start();
            }
          `,
        },
      ],
      [
        {
          filePath: 'src/main/services/syntheticBootstrap.ts',
          marker: 'bootSuperMcp',
          rationale: 'Synthetic opt-in for allowlist behavior coverage.',
        },
      ],
    );

    expect(result.failed).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]?.matchedAllowlistIndex).toBe(0);
  });

  it('detects named import aliases, namespace imports, and local aliases', () => {
    const result = runSynthetic([
      {
        filePath: 'src/core/synthetic/aliasStarts.ts',
        sourceText: `
          import { superMcpHttpManager as importedManager } from './services/superMcpHttpManager';
          import * as superMcpManagerModule from '@core/services/superMcpHttpManager';

          const localManager = importedManager;

          export async function startFromAliases(): Promise<void> {
            await importedManager.start();
            void superMcpManagerModule.superMcpHttpManager.start();
            return localManager.start();
          }
        `,
      },
    ]);

    expect(result.failed).toBe(true);
    expect(result.occurrences.map((occurrence) => occurrence.receiverText)).toEqual([
      'importedManager',
      'superMcpManagerModule.superMcpHttpManager',
      'localManager',
    ]);
  });

  it('does not flag tests, internal this.start(), or unrelated start methods', () => {
    const result = checkSuperMcpSingleStartupPath({
      repoRoot,
      allowlist: [],
      sourceInputs: [
        managerSource,
        {
          filePath: 'src/main/services/__tests__/synthetic.test.ts',
          sourceText: `
            import { superMcpHttpManager } from '@core/services/superMcpHttpManager';
            await superMcpHttpManager.start();
          `,
        },
        {
          filePath: 'src/main/services/otherManager.ts',
          sourceText: `
            const otherManager = { start: async () => undefined };
            export async function bootOther(): Promise<void> {
              await otherManager.start();
              await this.start();
            }
          `,
        },
      ],
    });

    expect(result.failed).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.occurrences).toEqual([]);
  });

  it('fails closed when the canonical singleton export disappears', () => {
    const result = checkSuperMcpSingleStartupPath({
      repoRoot,
      sourceInputs: [
        {
          filePath: 'src/core/services/superMcpHttpManager.ts',
          sourceText: `
            export class SuperMcpHttpManager {}
            export const renamedManager = new SuperMcpHttpManager();
          `,
        },
      ],
    });

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'missing_singleton_export',
          filePath: 'src/core/services/superMcpHttpManager.ts',
        }),
      ]),
    );
  });

  it('fails when an allowlist entry no longer matches any live occurrence', () => {
    const result = runSynthetic([], [
      {
        filePath: 'src/main/services/removedBootstrap.ts',
        marker: 'removedBoot',
        rationale: 'Synthetic stale entry for anti-rot testing.',
      },
    ]);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'stale_allowlist_entry',
          filePath: 'src/main/services/removedBootstrap.ts',
        }),
      ]),
    );
  });

  it('is wired into validate:fast next to the Super-MCP restart awaiter guard', () => {
    const stepNames = STEPS.map((step) => step.name);
    const awaiterIndex = stepNames.indexOf('check-supermcp-restart-awaiters');
    const startupPathIndex = stepNames.indexOf('check-supermcp-single-startup-path');

    expect(awaiterIndex).toBeGreaterThan(-1);
    expect(startupPathIndex).toBe(awaiterIndex + 1);
    expect(STEPS[startupPathIndex]?.command).toBe(
      'npx tsx scripts/check-supermcp-single-startup-path.ts',
    );
  });
});
