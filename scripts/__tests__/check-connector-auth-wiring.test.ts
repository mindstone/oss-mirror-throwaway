import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AUTH_API_EXCEPTIONS,
  checkConnectorAuthWiring,
  collectCatalogAuthApiUsages,
  collectStartupAuthRegistrations,
} from '../check-connector-auth-wiring';
import { STEPS } from '../run-validate-fast';

const REPO_ROOT = process.cwd();
const MAIN_STARTUP_PATH = path.join(REPO_ROOT, 'src', 'main', 'index.ts');
const CATALOG_PATH = path.join(REPO_ROOT, 'resources', 'connector-catalog.json');

describe('check-connector-auth-wiring', () => {
  it('passes for the current catalog after accounting for documented exceptions', () => {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as unknown;
    const result = checkConnectorAuthWiring({
      catalog,
      startupPath: MAIN_STARTUP_PATH,
      readFile: (filePath) => readFileSync(filePath, 'utf8'),
    });

    expect(result.violations).toEqual([]);
    expect(result.registrations.map((registration) => registration.authApi).sort()).toEqual([
      'googleWorkspaceApi',
      'hubspotApi',
      'microsoftApi',
      'slackApi',
    ]);
    expect(result.exempt).toEqual([
      expect.objectContaining({
        authApi: 'discourseApi',
        reason: expect.stringContaining('Dedicated Discourse IPC auth flow'),
      }),
    ]);
  });

  it('fails a catalog authApi with no startup registration and no exception', () => {
    const startupPath = '/repo/src/main/index.ts';
    const orchestratorPath = '/repo/src/main/services/slackAuthOrchestrator.ts';
    const files = new Map<string, string>([
      [
        startupPath,
        [
          `import { registerSlackApiAuthOrchestrator } from './services/slackAuthOrchestrator';`,
          ``,
          `app.whenReady().then(() => {`,
          `  registerSlackApiAuthOrchestrator();`,
          `});`,
        ].join('\n'),
      ],
      [
        orchestratorPath,
        [
          `import { registerAuthOrchestrator } from './mcpService';`,
          ``,
          `export function registerSlackApiAuthOrchestrator(): void {`,
          `  registerAuthOrchestrator('slackApi', async () => undefined);`,
          `}`,
        ].join('\n'),
      ],
    ]);
    const catalog = {
      connectors: [
        { id: 'slack', bundledConfig: { authApi: 'slackApi' } },
        { id: 'missing', bundledConfig: { authApi: 'missingApi' } },
      ],
    };

    const result = checkConnectorAuthWiring({
      catalog,
      startupPath,
      readFile: (filePath) => {
        const source = files.get(filePath);
        if (source === undefined) throw new Error(`unexpected read: ${filePath}`);
        return source;
      },
      fileExists: (filePath) => files.has(filePath),
      exceptions: [],
    });

    expect(result.violations).toEqual([
      { authApi: 'missingApi', connectorIds: ['missing'] },
    ]);
  });

  it('collects distinct catalog authApi usages with connector IDs', () => {
    expect(
      collectCatalogAuthApiUsages({
        connectors: [
          { id: 'first', bundledConfig: { authApi: 'alphaApi' } },
          { id: 'second', bundledConfig: { authApi: 'alphaApi' } },
          { id: 'third', bundledConfig: { authApi: 'betaApi' } },
          { id: 'ignored', bundledConfig: { authType: 'none' } },
        ],
      }),
    ).toEqual([
      { authApi: 'alphaApi', connectorIds: ['first', 'second'] },
      { authApi: 'betaApi', connectorIds: ['third'] },
    ]);
  });

  it('only treats registration calls inside startup-called imported functions as wired', () => {
    const startupPath = '/repo/src/main/index.ts';
    const calledPath = '/repo/src/main/services/calledAuthOrchestrator.ts';
    const uncalledPath = '/repo/src/main/services/uncalledAuthOrchestrator.ts';
    const files = new Map<string, string>([
      [
        startupPath,
        [
          `import { registerCalledAuthOrchestrator } from './services/calledAuthOrchestrator';`,
          `import { registerUncalledAuthOrchestrator } from './services/uncalledAuthOrchestrator';`,
          ``,
          `app.whenReady().then(() => {`,
          `  registerCalledAuthOrchestrator();`,
          `});`,
          `function later(): void {`,
          `  registerUncalledAuthOrchestrator();`,
          `}`,
        ].join('\n'),
      ],
      [
        calledPath,
        [
          `export function registerCalledAuthOrchestrator(): void {`,
          `  registerAuthOrchestrator('calledApi', async () => undefined);`,
          `}`,
        ].join('\n'),
      ],
      [
        uncalledPath,
        [
          `export function registerUncalledAuthOrchestrator(): void {`,
          `  registerAuthOrchestrator('uncalledApi', async () => undefined);`,
          `}`,
        ].join('\n'),
      ],
    ]);

    const registrations = collectStartupAuthRegistrations(
      startupPath,
      (filePath) => {
        const source = files.get(filePath);
        if (source === undefined) throw new Error(`unexpected read: ${filePath}`);
        return source;
      },
      (filePath) => files.has(filePath),
    );

    expect(registrations.map((registration) => registration.authApi)).toEqual(['calledApi']);
  });

  it('does NOT count conditional or dead registrations as wired (fail-closed reachability)', () => {
    // Regression guard for the false-pass class: a registration hidden behind a
    // feature flag / if(false) / nested fn must read as MISSING, while an
    // unconditional registration inside a try-block must still count.
    const startupPath = '/repo/src/main/index.ts';
    const condPath = '/repo/src/main/services/conditionalAuthOrchestrator.ts';
    const tryPath = '/repo/src/main/services/tryAuthOrchestrator.ts';
    const files = new Map<string, string>([
      [
        startupPath,
        [
          `import { registerConditionalAuthOrchestrator } from './services/conditionalAuthOrchestrator';`,
          `import { registerTryAuthOrchestrator } from './services/tryAuthOrchestrator';`,
          ``,
          `app.whenReady().then(() => {`,
          `  if (someFeatureFlag) {`,
          `    registerConditionalAuthOrchestrator();`, // conditional call → must NOT count
          `  }`,
          `  registerTryAuthOrchestrator();`, // unconditional call → counts
          `});`,
        ].join('\n'),
      ],
      [
        condPath,
        [
          `export function registerConditionalAuthOrchestrator(): void {`,
          `  if (false) {`,
          `    registerAuthOrchestrator('conditionalApi', async () => undefined);`, // dead → must NOT count
          `  }`,
          `}`,
        ].join('\n'),
      ],
      [
        tryPath,
        [
          `export function registerTryAuthOrchestrator(): void {`,
          `  try {`,
          `    registerAuthOrchestrator('tryWiredApi', async () => undefined);`, // unconditional (try) → counts
          `  } finally {`,
          `    noop();`,
          `  }`,
          `}`,
        ].join('\n'),
      ],
    ]);

    const registrations = collectStartupAuthRegistrations(
      startupPath,
      (filePath) => {
        const source = files.get(filePath);
        if (source === undefined) throw new Error(`unexpected read: ${filePath}`);
        return source;
      },
      (filePath) => files.has(filePath),
    );

    const wired = registrations.map((registration) => registration.authApi);
    expect(wired).toContain('tryWiredApi');
    expect(wired).not.toContain('conditionalApi');
  });

  it('documents the only current non-orchestrator authApi exception', () => {
    expect(AUTH_API_EXCEPTIONS.map((exception) => exception.authApi)).toEqual(['discourseApi']);
  });

  it('is wired into validate:fast', () => {
    const step = STEPS.find((candidate) => candidate.name === 'validate:connector-auth-wiring');
    expect(step?.command).toBe('npm run validate:connector-auth-wiring');

    const packageJson = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['validate:connector-auth-wiring']).toBe(
      'npx tsx scripts/check-connector-auth-wiring.ts',
    );
  });
});
