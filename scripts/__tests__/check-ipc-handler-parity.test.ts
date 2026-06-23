import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findIpcHandlerParityViolations } from '../check-ipc-handler-parity';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ipc-handler-parity-'));
  tempRoots.push(root);
  return root;
}

function writeFixtureFile(root: string, relativePath: string, source: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, 'utf8');
}

function createFixture(options: {
  contractChannels: string[];
  handlerSource: string;
}): string {
  const root = createTempRoot();

  const channelsSource = [
    'export const testChannels = {',
    ...options.contractChannels.map((channel) => [
      `  '${channel}': {`,
      `    channel: '${channel}',`,
      '    request: null,',
      '    response: null,',
      '  },',
    ].join('\n')),
    '} as const;',
    '',
  ].join('\n');

  const contractsSource = [
    "import { testChannels } from './channels/test';",
    'export const ipcContract = {',
    '  test: testChannels,',
    '} as const;',
    '',
  ].join('\n');

  writeFixtureFile(root, 'src/shared/ipc/channels/test.ts', channelsSource);
  writeFixtureFile(root, 'src/shared/ipc/contracts.ts', contractsSource);
  writeFixtureFile(root, 'src/main/ipc/testHandlers.ts', options.handlerSource);

  return root;
}

describe('check-ipc-handler-parity', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes when all contract channels have matching handlers', () => {
    const root = createFixture({
      contractChannels: ['test:one', 'test:two'],
      handlerSource: [
        "import { testChannels } from '@shared/ipc/channels/test';",
        'export function registerTestHandlers(): void {',
        "  registerHandler('test:one', async () => null);",
        "  const twoChannel = testChannels['test:two'];",
        '  ipcMain.handle(twoChannel.channel, async () => null);',
        '}',
      ].join('\n'),
    });

    const result = findIpcHandlerParityViolations({ repoRoot: root });
    expect(result.missingHandlers).toEqual([]);
    expect(result.handlerWithoutContract).toEqual([]);
  });

  it('reports contract channels that do not have a handler registration', () => {
    const root = createFixture({
      contractChannels: ['test:one', 'test:missing'],
      handlerSource: [
        'export function registerTestHandlers(): void {',
        "  registerHandler('test:one', async () => null);",
        '}',
      ].join('\n'),
    });

    const result = findIpcHandlerParityViolations({ repoRoot: root });
    expect(result.missingHandlers).toEqual(['test:missing']);
  });

  it('reports handler channels that are not declared in contracts as warnings', () => {
    const root = createFixture({
      contractChannels: ['test:one'],
      handlerSource: [
        'export function registerTestHandlers(): void {',
        "  registerHandler('test:one', async () => null);",
        "  registerHandler('legacy:unknown', async () => null);",
        '}',
      ].join('\n'),
    });

    const result = findIpcHandlerParityViolations({ repoRoot: root });
    expect(result.missingHandlers).toEqual([]);
    expect(result.handlerWithoutContract).toEqual(['legacy:unknown']);
  });

  it('honors allowlist entries for intentionally non-standard channels', () => {
    const root = createFixture({
      contractChannels: ['test:one', 'test:allowlisted'],
      handlerSource: [
        'export function registerTestHandlers(): void {',
        "  registerHandler('test:one', async () => null);",
        '}',
      ].join('\n'),
    });

    const result = findIpcHandlerParityViolations({
      repoRoot: root,
      allowlistedMissingHandlers: new Set(['test:allowlisted']),
    });

    expect(result.missingHandlers).toEqual([]);
  });

  it('detects stale missing-handler allowlist entries', () => {
    const root = createFixture({
      contractChannels: ['test:one'],
      handlerSource: [
        'export function registerTestHandlers(): void {',
        "  registerHandler('test:one', async () => null);",
        '}',
      ].join('\n'),
    });

    const result = findIpcHandlerParityViolations({
      repoRoot: root,
      // 'test:gone' is not a real contract channel, so it's stale
      allowlistedMissingHandlers: new Set(['test:gone']),
    });

    expect(result.missingHandlers).toEqual([]);
    expect(result.staleAllowlistEntries).toEqual(
      expect.arrayContaining([
        { channel: 'test:gone', allowlist: 'missingHandler' },
      ]),
    );
  });

  it('detects stale extra-handler allowlist entries', () => {
    const root = createFixture({
      contractChannels: ['test:one'],
      handlerSource: [
        'export function registerTestHandlers(): void {',
        "  registerHandler('test:one', async () => null);",
        '}',
      ].join('\n'),
    });

    const result = findIpcHandlerParityViolations({
      repoRoot: root,
      // 'legacy:removed' is not registered anywhere, so it's stale
      allowlistedExtraHandlers: new Set(['legacy:removed']),
    });

    expect(result.staleAllowlistEntries).toEqual(
      expect.arrayContaining([
        { channel: 'legacy:removed', allowlist: 'extraHandler' },
      ]),
    );
  });

  it('resolves channel constants from shared channel groups', () => {
    const root = createFixture({
      contractChannels: ['test:constant'],
      handlerSource: [
        "import { testChannels } from '@shared/ipc/channels/test';",
        'export function registerTestHandlers(): void {',
        "  const channelDef = testChannels['test:constant'];",
        '  registerHandler(channelDef.channel, async () => null);',
        '}',
      ].join('\n'),
    });

    const result = findIpcHandlerParityViolations({ repoRoot: root });
    expect(result.missingHandlers).toEqual([]);
    expect(result.handlerChannels).toContain('test:constant');
  });

  it('scans private and OSS stub handler roots while skipping missing roots', () => {
    const root = createTempRoot();

    writeFixtureFile(root, 'src/shared/ipc/channels/test.ts', [
      'export const testChannels = {',
      "  'test:private': {",
      "    channel: 'test:private',",
      '    request: null,',
      '    response: null,',
      '  },',
      "  'test:oss-stub': {",
      "    channel: 'test:oss-stub',",
      '    request: null,',
      '    response: null,',
      '  },',
      '} as const;',
      '',
    ].join('\n'));
    writeFixtureFile(root, 'src/shared/ipc/contracts.ts', [
      "import { testChannels } from './channels/test';",
      'export const ipcContract = {',
      '  test: testChannels,',
      '} as const;',
      '',
    ].join('\n'));
    writeFixtureFile(root, 'private/mindstone/src/ipc/authHandlers.ts', [
      "import { testChannels } from '@shared/ipc/channels/test';",
      'export function registerAuthHandlers(): void {',
      "  registerHandler(testChannels['test:private'].channel, async () => null);",
      '}',
    ].join('\n'));
    writeFixtureFile(root, 'src/main/oss/private-mindstone-stub/ipc/authHandlers.ts', [
      "import { testChannels } from '@shared/ipc/channels/test';",
      'export function registerAuthHandlers(): void {',
      "  registerHandler(testChannels['test:oss-stub'].channel, async () => null);",
      '}',
    ].join('\n'));

    const result = findIpcHandlerParityViolations({ repoRoot: root });

    expect(result.missingHandlers).toEqual([]);
    expect(result.handlerChannels).toContain('test:private');
    expect(result.handlerChannels).toContain('test:oss-stub');
  });
});
