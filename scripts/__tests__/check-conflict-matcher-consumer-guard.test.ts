import { describe, expect, it } from 'vitest';
import {
  ADDITIONAL_REGISTERED_SOURCE_PATHS,
  checkConflictMatcherConsumerGuard,
  DEFAULT_CONFLICT_MATCHER_SURFACE_REGISTRY,
  formatGuardResult,
  type ConflictMatcherSurfaceEntry,
  type SourceInput,
} from '../check-conflict-matcher-consumer-guard';

const repoRoot = process.cwd();

function runSynthetic(
  registry: readonly ConflictMatcherSurfaceEntry[],
  sourceInputs: readonly SourceInput[],
) {
  return checkConflictMatcherConsumerGuard({
    repoRoot,
    registry,
    sourceInputs,
  });
}

describe('check-conflict-matcher-consumer-guard', () => {
  it('passes for the real registered repo surfaces', () => {
    const result = checkConflictMatcherConsumerGuard({ repoRoot });

    expect(formatGuardResult(result)).toContain('Conflict-matcher consumer guard passed');
    expect(result.failed).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.producerCandidates).toContain('src/main/services/cloud/cloudWorkspaceSync.ts');
  });

  it('registers cloud-service buildCloudManifest as an explicit out-of-src guarded surface', () => {
    const cloudLibraryPath = 'cloud-service/src/routes/library.ts';

    expect(ADDITIONAL_REGISTERED_SOURCE_PATHS).toContain(cloudLibraryPath);
    expect(
      DEFAULT_CONFLICT_MATCHER_SURFACE_REGISTRY.some((entry) => entry.filePath === cloudLibraryPath),
    ).toBe(true);

    const result = checkConflictMatcherConsumerGuard({ repoRoot });

    expect(result.failed).toBe(false);
    expect(
      result.failures.filter((failure) => failure.filePath === cloudLibraryPath),
    ).toEqual([]);
  });

  it('fails when the registered cloud-service buildCloudManifest drops a required guard call', () => {
    const cloudLibraryPath = 'cloud-service/src/routes/library.ts';
    const registry: ConflictMatcherSurfaceEntry[] = [
      {
        filePath: cloudLibraryPath,
        classification: 'sync_propagation_requires_conflict_matcher',
        functionRequirements: [
          {
            functionName: 'buildCloudManifest',
            requiredIdentifiers: ['isSuppressibleConflictCopy', 'isSuppressibleConflictDir'],
          },
        ],
      },
    ];
    const sourceInputs: SourceInput[] = [
      {
        filePath: cloudLibraryPath,
        sourceText: `
          function isSuppressibleConflictDir() { return true; }
          export async function buildCloudManifest(workspaceDir: string) {
            await safeWalkDirectory(workspaceDir, {
              onDirectory: ({ name }) => {
                isSuppressibleConflictDir(name, () => true);
                return true;
              },
              onFile: async () => {},
            });
            return { entries: {}, complete: true, reasons: [] };
          }
        `,
      },
    ];

    const result = runSynthetic(registry, sourceInputs);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'missing_function_guard',
          filePath: cloudLibraryPath,
          detail: expect.stringContaining('isSuppressibleConflictCopy'),
        }),
      ]),
    );
  });

  it('fails when a registered sync-propagation function drops a required guard call', () => {
    const registry: ConflictMatcherSurfaceEntry[] = [
      {
        filePath: 'src/main/services/cloud/syntheticSync.ts',
        classification: 'sync_propagation_requires_conflict_matcher',
        functionRequirements: [
          {
            functionName: 'buildLocalManifest',
            requiredIdentifiers: ['isSuppressibleConflictCopy', 'isSuppressibleConflictDir'],
          },
        ],
      },
    ];
    const sourceInputs: SourceInput[] = [
      {
        filePath: 'src/main/services/cloud/syntheticSync.ts',
        sourceText: `
          type SyncClient = {};
          function isSuppressibleConflictDir() { return true; }
          export async function buildLocalManifest(workspacePath: string) {
            isSuppressibleConflictDir();
            return fs.promises.writeFile(workspacePath, 'x');
          }
        `,
      },
    ];

    const result = runSynthetic(registry, sourceInputs);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'missing_function_guard',
          filePath: 'src/main/services/cloud/syntheticSync.ts',
          detail: expect.stringContaining('isSuppressibleConflictCopy'),
        }),
      ]),
    );
  });

  it('fails when a new cloud-ingest workspace-write module is not classified', () => {
    const result = runSynthetic([], [
      {
        filePath: 'src/main/services/cloud/newBypass.ts',
        sourceText: `
          import fs from 'node:fs';
          type SyncClient = {};
          export async function ingestFromCloud(client: SyncClient, workspacePath: string) {
            await fs.promises.writeFile(workspacePath, 'cloud content');
          }
        `,
      },
    ]);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual([
      expect.objectContaining({
        kind: 'unclassified_producer',
        filePath: 'src/main/services/cloud/newBypass.ts',
      }),
    ]);
  });

  it('fails when a new cloud-service writer has no ingest literal and a non-hint write target', () => {
    const result = runSynthetic([], [
      {
        filePath: 'src/main/services/cloud/foo.ts',
        sourceText: `
          import fs from 'node:fs';
          import path from 'node:path';
          export async function pull(root: string, name: string, body: string) {
            const dest = path.join(root, name);
            await fs.promises.writeFile(dest, body);
          }
        `,
      },
    ]);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual([
      expect.objectContaining({
        kind: 'unclassified_producer',
        filePath: 'src/main/services/cloud/foo.ts',
      }),
    ]);
  });

  it('fails when only the module imports the matcher and the required function body lacks it', () => {
    const registry: ConflictMatcherSurfaceEntry[] = [
      {
        filePath: 'src/main/services/cloud/importOnlySync.ts',
        classification: 'sync_propagation_requires_conflict_matcher',
        functionRequirements: [
          {
            functionName: 'pullChangedFiles',
            requiredIdentifiers: ['isSuppressibleConflictCopy'],
          },
        ],
      },
    ];
    const sourceInputs: SourceInput[] = [
      {
        filePath: 'src/main/services/cloud/importOnlySync.ts',
        sourceText: `
          import { matchConflictPattern as isSuppressibleConflictCopy } from '@shared/conflictPatterns';
          type SyncClient = {};
          export function unrelated() {
            return isSuppressibleConflictCopy;
          }
          export async function pullChangedFiles(client: SyncClient, workspacePath: string) {
            await fs.promises.writeFile(workspacePath, 'cloud content');
          }
        `,
      },
    ];

    const result = runSynthetic(registry, sourceInputs);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'missing_function_guard',
          detail: expect.stringContaining('pullChangedFiles'),
        }),
      ]),
    );
  });

  it('fails when the required guard appears inside a function body but is not called', () => {
    const registry: ConflictMatcherSurfaceEntry[] = [
      {
        filePath: 'src/main/services/cloud/nonCallSync.ts',
        classification: 'sync_propagation_requires_conflict_matcher',
        functionRequirements: [
          {
            functionName: 'pullChangedFiles',
            requiredIdentifiers: ['isSuppressibleConflictCopy'],
          },
        ],
      },
    ];
    const sourceInputs: SourceInput[] = [
      {
        filePath: 'src/main/services/cloud/nonCallSync.ts',
        sourceText: `
          import fs from 'node:fs';
          declare const isSuppressibleConflictCopy: () => boolean;
          export async function pullChangedFiles(workspacePath: string) {
            // isSuppressibleConflictCopy must be invoked, not only mentioned.
            const guardReference = isSuppressibleConflictCopy;
            await fs.promises.writeFile(workspacePath, 'cloud content');
            return guardReference;
          }
        `,
      },
    ];

    const result = runSynthetic(registry, sourceInputs);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'missing_function_guard',
          detail: expect.stringContaining('does not call required guard `isSuppressibleConflictCopy`'),
        }),
      ]),
    );
  });

  it('passes for an explicitly exempt origination surface with rationale', () => {
    const registry: ConflictMatcherSurfaceEntry[] = [
      {
        filePath: 'src/main/services/cloud/originationBridge.ts',
        classification: 'origin_authoring_pending_exempt',
        rationale:
          'Writes agent-authored pendingDestination paths, not Drive-FS-scanned names; kept registered so future scan-derived destinations force re-classification.',
      },
    ];
    const sourceInputs: SourceInput[] = [
      {
        filePath: 'src/main/services/cloud/originationBridge.ts',
        sourceText: `
          import fs from 'node:fs';
          export async function relayPending(pendingDestination: string, absolutePath: string) {
            await writeToPending({ destinationPath: pendingDestination });
            await fs.promises.writeFile(absolutePath, 'agent-authored content');
          }
        `,
      },
    ];

    const result = runSynthetic(registry, sourceInputs);

    expect(result.failed).toBe(false);
    expect(result.failures).toEqual([]);
  });
});
