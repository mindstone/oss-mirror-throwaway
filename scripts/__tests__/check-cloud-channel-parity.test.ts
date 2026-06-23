import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findCloudChannelParityViolations } from '../check-cloud-channel-parity';

const tempRoots: string[] = [];

interface FixtureOptions {
  policiesSource: string;
  ipcRouteSource?: string;
  cloudRouterSource?: string;
  serverSource?: string;
  routeFiles?: Record<string, string>;
  allowlistedChannels?: string[];
}

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cloud-channel-parity-'));
  tempRoots.push(root);
  return root;
}

function writeFixtureFile(root: string, relativePath: string, source: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, 'utf8');
}

function runFixture(options: FixtureOptions) {
  const root = createTempRoot();

  writeFixtureFile(root, 'src/shared/cloudChannelPolicies.ts', options.policiesSource);
  writeFixtureFile(
    root,
    'cloud-service/src/routes/ipc.ts',
    options.ipcRouteSource ?? [
      "import { CLOUD_IPC_ALLOWLIST as SHARED_IPC_ALLOWLIST } from '@shared/cloudChannelPolicies';",
      'export const CLOUD_IPC_ALLOWLIST = new Set([',
      '  ...SHARED_IPC_ALLOWLIST,',
      "  'sessions:save-sync',",
      ']);',
    ].join('\n'),
  );
  writeFixtureFile(
    root,
    'src/main/services/cloud/cloudRouter.ts',
    options.cloudRouterSource ?? [
      'const CHANNEL_TO_ENDPOINT: Record<string, unknown> = {',
      "  'settings:update': { method: 'PATCH', path: '/api/settings', bodyArgIndex: 0 },",
      '};',
    ].join('\n'),
  );
  writeFixtureFile(
    root,
    'cloud-service/src/server.ts',
    options.serverSource ?? [
      "import { handleSettings } from './routes';",
      'async function handleRoute(route: string, req: unknown, res: unknown, deps: unknown): Promise<void> {',
      "  if (route === '/api/settings') {",
      '    return await handleSettings(req, res, deps);',
      '  }',
      '}',
    ].join('\n'),
  );

  const routeFiles = {
    'settings.ts': 'export async function handleSettings(): Promise<void> {}',
    ...(options.routeFiles ?? {}),
  };
  for (const [relativeRoutePath, source] of Object.entries(routeFiles)) {
    writeFixtureFile(root, `cloud-service/src/routes/${relativeRoutePath}`, source);
  }

  return findCloudChannelParityViolations({
    repoRoot: root,
    allowlistedChannels: new Set(options.allowlistedChannels ?? []),
  });
}

describe('check-cloud-channel-parity', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes when all declared channels have cloud coverage', () => {
    const result = runFixture({
      policiesSource: [
        'export const CLOUD_CHANNEL_POLICIES = {',
        "  'inbox:add': { routable: true, transport: 'ipc' },",
        "  'settings:update': { routable: true, transport: 'rest' },",
        '} as const;',
      ].join('\n'),
    });

    expect(result.violations).toEqual([]);
  });

  it('reports a violation when a declared REST channel is missing cloud route coverage', () => {
    const result = runFixture({
      policiesSource: [
        'export const CLOUD_CHANNEL_POLICIES = {',
        "  'settings:update': { routable: true, transport: 'rest' },",
        '} as const;',
      ].join('\n'),
      serverSource: [
        'async function handleRoute(route: string): Promise<void> {',
        "  if (route === '/api/health') return;",
        '}',
      ].join('\n'),
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual(
      expect.objectContaining({
        channel: 'settings:update',
        transport: 'rest',
      }),
    );
  });

  it('does not report violations for allowlisted channels', () => {
    const result = runFixture({
      policiesSource: [
        'export const CLOUD_CHANNEL_POLICIES = {',
        "  'desktop:only': { routable: true, transport: 'rest' },",
        '} as const;',
      ].join('\n'),
      allowlistedChannels: ['desktop:only'],
    });

    expect(result.violations).toEqual([]);
  });

  it('passes IPC channels when explicitly present in cloud IPC allowlist', () => {
    const result = runFixture({
      policiesSource: [
        'export const CLOUD_CHANNEL_POLICIES = {',
        "  'tool-safety:pending': { routable: true, transport: 'ipc' },",
        '} as const;',
      ].join('\n'),
      ipcRouteSource: [
        'export const CLOUD_IPC_ALLOWLIST = new Set([',
        "  'tool-safety:pending',",
        ']);',
      ].join('\n'),
    });

    expect(result.violations).toEqual([]);
  });

  it('passes REST channels when server.ts directly references the channel string', () => {
    const result = runFixture({
      policiesSource: [
        'export const CLOUD_CHANNEL_POLICIES = {',
        "  'custom:rest-channel': { routable: true, transport: 'rest' },",
        '} as const;',
      ].join('\n'),
      cloudRouterSource: 'const CHANNEL_TO_ENDPOINT: Record<string, unknown> = {};',
      serverSource: [
        'async function handleRoute(): Promise<void> {',
        "  const channel = 'custom:rest-channel';",
        '  void channel;',
        '}',
      ].join('\n'),
    });

    expect(result.violations).toEqual([]);
  });
});
