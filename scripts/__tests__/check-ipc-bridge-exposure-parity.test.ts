import { describe, expect, it } from 'vitest';

import { findIpcBridgeExposureParityViolations } from '../check-ipc-bridge-exposure-parity';

const REPO_ROOT = '/repo';

const PATHS = {
  ipcBridgeFile: 'src/preload/ipcBridge.ts',
  preloadFile: 'src/preload/index.ts',
  rendererEnvFile: 'src/renderer/env.d.ts',
} as const;

function makeReadFile(files: Record<string, string>): (absolutePath: string) => string {
  return (absolutePath: string): string => {
    const source = files[absolutePath];
    if (source === undefined) throw new Error(`unexpected read: ${absolutePath}`);
    return source;
  };
}

function makeBridgeSource(exportNames: readonly string[]): string {
  return exportNames.map((name) => `export const ${name} = {};`).join('\n');
}

function makePreloadSource(exposures: ReadonlyArray<{ name: string; valueExpression?: string }>): string {
  return exposures
    .map((exposure) => (
      `contextBridge.exposeInMainWorld('${exposure.name}', ${exposure.valueExpression ?? exposure.name});`
    ))
    .join('\n');
}

function makeWindowSource(fieldNames: readonly string[]): string {
  return [
    'declare global {',
    '  interface Window {',
    ...fieldNames.map((name) => `    ${name}: unknown;`),
    '  }',
    '}',
    'export {};',
  ].join('\n');
}

function runFixture(options: {
  bridgeExports: readonly string[];
  exposures: ReadonlyArray<{ name: string; valueExpression?: string }>;
  windowFields: readonly string[];
  requiredDomains: readonly string[];
}) {
  return findIpcBridgeExposureParityViolations({
    repoRoot: REPO_ROOT,
    paths: PATHS,
    readFile: makeReadFile({
      [`${REPO_ROOT}/${PATHS.ipcBridgeFile}`]: makeBridgeSource(options.bridgeExports),
      [`${REPO_ROOT}/${PATHS.preloadFile}`]: makePreloadSource(options.exposures),
      [`${REPO_ROOT}/${PATHS.rendererEnvFile}`]: makeWindowSource(options.windowFields),
    }),
    connectorDomains: options.requiredDomains.map((name) => ({
      name,
      reason: `${name} is required by the fixture.`,
    })),
    knownDebtAllowlist: [],
    legacyAliases: [],
    mainOnlyBridgeExports: [],
    nonIpcBridgeExposures: [],
  });
}

function expectNoViolations(result: ReturnType<typeof runFixture>): void {
  expect(result.exposedWithoutBridgeExport).toEqual([]);
  expect(result.exposedWithoutWindowType).toEqual([]);
  expect(result.legacyAliasTargetViolations).toEqual([]);
  expect(result.connectorDomainValueBindingViolations).toEqual([]);
  expect(result.connectorDomainsMissingExport).toEqual([]);
  expect(result.connectorDomainsMissingExposure).toEqual([]);
  expect(result.connectorDomainsMissingWindowType).toEqual([]);
  expect(result.bridgeExportClassificationConflicts).toEqual([]);
  expect(result.unclassifiedBridgeExports).toEqual([]);
  expect(result.mainOnlyBridgeExportsExposed).toEqual([]);
  expect(result.staleAllowlistEntries).toEqual([]);
}

describe('check-ipc-bridge-exposure-parity', () => {
  it('passes a well-formed renderer-facing bridge fixture', () => {
    const result = runFixture({
      bridgeExports: ['githubApi', 'slackApi'],
      exposures: [{ name: 'githubApi' }, { name: 'slackApi' }],
      windowFields: ['githubApi', 'slackApi'],
      requiredDomains: ['githubApi', 'slackApi'],
    });

    expectNoViolations(result);
  });

  it('reports a required domain missing its preload exposure', () => {
    const result = runFixture({
      bridgeExports: ['githubApi', 'slackApi'],
      exposures: [{ name: 'slackApi' }],
      windowFields: ['githubApi', 'slackApi'],
      requiredDomains: ['githubApi', 'slackApi'],
    });

    expect(result.connectorDomainsMissingExposure).toEqual([
      expect.objectContaining({ name: 'githubApi' }),
    ]);
  });

  it('reports a required domain missing its Window ambient type', () => {
    const result = runFixture({
      bridgeExports: ['githubApi', 'slackApi'],
      exposures: [{ name: 'githubApi' }, { name: 'slackApi' }],
      windowFields: ['slackApi'],
      requiredDomains: ['githubApi', 'slackApi'],
    });

    expect(result.connectorDomainsMissingWindowType).toEqual([
      expect.objectContaining({ name: 'githubApi' }),
    ]);
    expect(result.exposedWithoutWindowType.map((exposure) => exposure.name)).toEqual(['githubApi']);
  });

  it('reports a required domain whose exposure is bound to the wrong value', () => {
    const result = runFixture({
      bridgeExports: ['githubApi', 'slackApi'],
      exposures: [
        { name: 'githubApi', valueExpression: 'slackApi' },
        { name: 'slackApi' },
      ],
      windowFields: ['githubApi', 'slackApi'],
      requiredDomains: ['githubApi', 'slackApi'],
    });

    expect(result.connectorDomainValueBindingViolations).toEqual([
      'githubApi should expose githubApi, but exposes slackApi',
    ]);
  });

  it('reports an unclassified ipcBridge *Api export', () => {
    const result = runFixture({
      bridgeExports: ['githubApi', 'slackApi', 'unclassifiedApi'],
      exposures: [{ name: 'githubApi' }, { name: 'slackApi' }],
      windowFields: ['githubApi', 'slackApi'],
      requiredDomains: ['githubApi', 'slackApi'],
    });

    expect(result.unclassifiedBridgeExports).toEqual(['unclassifiedApi']);
  });
});
