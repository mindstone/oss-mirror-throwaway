import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  planPublishSuperMcp,
  publishSuperMcp,
  PublishSuperMcpError,
  type NpmRunResult,
  type PublishSuperMcpDeps,
} from '../publish-super-mcp';

const REPO_ROOT = '/repo';
const VERSION = '2.5.0';

interface MockDepsOptions {
  readonly packageJson?: Record<string, unknown>;
  readonly generatedVersion?: string;
  readonly distExists?: boolean;
  readonly npmResults: readonly NpmRunResult[];
}

function ok(stdout = ''): NpmRunResult {
  return { status: 0, stdout, stderr: '' };
}

function notFound(): NpmRunResult {
  return { status: 1, stdout: '', stderr: 'npm ERR! code E404\nnpm ERR! 404 No match found' };
}

function conflict(): NpmRunResult {
  return {
    status: 1,
    stdout: '',
    stderr: 'npm ERR! code E409\nnpm ERR! You cannot publish over the previously published versions.',
  };
}

function packJson(files: readonly string[] = defaultPackedFiles()): string {
  return JSON.stringify([
    {
      id: `super-mcp-router@${VERSION}`,
      files: files.map((filePath) => ({ path: filePath })),
    },
  ]);
}

function defaultPackageJson(): Record<string, unknown> {
  return {
    name: 'super-mcp-router',
    version: VERSION,
    files: ['dist/', 'super-mcp-config.example.json', 'README.md', 'LICENSE', 'CHANGELOG.md'],
  };
}

function defaultPackedFiles(): string[] {
  return [
    'dist/cli.js',
    'dist/server.js',
    'super-mcp-config.example.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
  ];
}

function makeDeps(options: MockDepsOptions): {
  deps: PublishSuperMcpDeps;
  calls: Array<{ args: readonly string[]; cwd: string }>;
} {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const npmResults = [...options.npmResults];
  const packageJson = options.packageJson ?? defaultPackageJson();

  const deps: PublishSuperMcpDeps = {
    cwd: REPO_ROOT,
    generatedVersion: options.generatedVersion ?? VERSION,
    verifyAttempts: 3,
    verifyDelayMs: 1,
    sleep: vi.fn(),
    readFile: vi.fn(async (filePath: string) => {
      expect(filePath).toBe(path.join(REPO_ROOT, 'super-mcp', 'package.json'));
      return JSON.stringify(packageJson);
    }),
    exists: vi.fn(async (filePath: string) => {
      expect(filePath).toBe(path.join(REPO_ROOT, 'super-mcp', 'dist', 'cli.js'));
      return options.distExists ?? true;
    }),
    runNpm: vi.fn(async (args: readonly string[], opts: { cwd: string }) => {
      calls.push({ args, cwd: opts.cwd });
      const next = npmResults.shift();
      if (!next) {
        throw new Error(`Unexpected npm call: npm ${args.join(' ')}`);
      }
      return next;
    }),
  };

  return { deps, calls };
}

function npmCommandNames(calls: Array<{ args: readonly string[] }>): string[] {
  return calls.map((call) => call.args[0] ?? '');
}

describe('publish-super-mcp', () => {
  it('skips when the current version is already published and never calls publish', async () => {
    const { deps, calls } = makeDeps({ npmResults: [ok(JSON.stringify(VERSION))] });

    const result = await publishSuperMcp(deps);

    expect(result.status).toBe('already-published');
    expect(result.messages.join('\n')).toMatch(/SKIP already published/);
    expect(npmCommandNames(calls)).toEqual(['view']);
  });

  it('runs pack preflight and publishes when the current version is absent', async () => {
    const { deps, calls } = makeDeps({ npmResults: [notFound(), ok(packJson()), ok('')] });

    const result = await publishSuperMcp(deps);

    expect(result.status).toBe('published');
    expect(result.messages.join('\n')).toMatch(/published super-mcp-router@2\.5\.0/);
    expect(calls).toEqual([
      { args: ['view', 'super-mcp-router@2.5.0', 'version', '--json'], cwd: REPO_ROOT },
      { args: ['pack', '--dry-run', '--json'], cwd: path.join(REPO_ROOT, 'super-mcp') },
      { args: ['publish', '--provenance', '--access', 'public'], cwd: path.join(REPO_ROOT, 'super-mcp') },
    ]);
  });

  it('preflight-only never calls publish when the package is publishable', async () => {
    const { deps, calls } = makeDeps({ npmResults: [notFound(), ok(packJson())] });

    const result = await publishSuperMcp(deps, { dryRun: true, preflightOnly: true });

    expect(result.status).toBe('would-publish');
    expect(result.messages).toEqual(['would publish super-mcp-router@2.5.0']);
    expect(npmCommandNames(calls)).toEqual(['view', 'pack']);
    expect(calls.some((call) => call.args[0] === 'publish')).toBe(false);
  });

  it('preflight-only fails clearly when dist/cli.js is missing', async () => {
    const { deps, calls } = makeDeps({ distExists: false, npmResults: [] });

    await expect(publishSuperMcp(deps, { preflightOnly: true })).rejects.toThrow(/Missing super-mcp\/dist\/cli\.js/);
    expect(calls).toEqual([]);
  });

  it('preflight-only fails clearly when package name is wrong', async () => {
    const { deps } = makeDeps({
      packageJson: { ...defaultPackageJson(), name: 'wrong-package' },
      npmResults: [],
    });

    await expect(planPublishSuperMcp(deps, { preflightOnly: true })).rejects.toMatchObject({
      code: 'wrong-package-name',
    } satisfies Partial<PublishSuperMcpError>);
  });

  it('preflight-only fails clearly when generated constant mismatches package version', async () => {
    const { deps } = makeDeps({ generatedVersion: '2.4.9', npmResults: [] });

    await expect(planPublishSuperMcp(deps, { preflightOnly: true })).rejects.toMatchObject({
      code: 'generated-version-mismatch',
    } satisfies Partial<PublishSuperMcpError>);
  });

  it('preflight-only fails when the dry-run tarball omits expected files', async () => {
    const { deps } = makeDeps({
      npmResults: [notFound(), ok(packJson(['dist/server.js', 'README.md', 'LICENSE', 'CHANGELOG.md']))],
    });

    await expect(publishSuperMcp(deps, { dryRun: true, preflightOnly: true })).rejects.toThrow(
      /missing expected super-mcp-router files: dist\/cli\.js, super-mcp-config\.example\.json/,
    );
  });

  it('dry-run performs preflight but never publishes', async () => {
    const { deps, calls } = makeDeps({ npmResults: [notFound(), ok(packJson())] });

    const result = await publishSuperMcp(deps, { dryRun: true });

    expect(result.status).toBe('dry-run');
    expect(npmCommandNames(calls)).toEqual(['view', 'pack']);
  });

  it('treats publish version-conflict as success when a follow-up view sees the version', async () => {
    const { deps, calls } = makeDeps({
      npmResults: [notFound(), ok(packJson()), conflict(), ok(JSON.stringify(VERSION))],
    });

    const result = await publishSuperMcp(deps);

    expect(result.status).toBe('published');
    expect(result.messages.join('\n')).toMatch(/another runner/);
    expect(npmCommandNames(calls)).toEqual(['view', 'pack', 'publish', 'view']);
  });

  it('fails publish version-conflict when a follow-up view still cannot see the version', async () => {
    const { deps, calls } = makeDeps({
      npmResults: [notFound(), ok(packJson()), conflict(), notFound()],
    });

    await expect(publishSuperMcp(deps)).rejects.toMatchObject({ code: 'npm-publish-failed' });
    expect(npmCommandNames(calls)).toEqual(['view', 'pack', 'publish', 'view']);
  });

  it('verify retries through propagation delay and succeeds once the version appears', async () => {
    const { deps, calls } = makeDeps({
      npmResults: [notFound(), ok(packJson()), ok(''), notFound(), ok(JSON.stringify(VERSION))],
    });

    const result = await publishSuperMcp(deps, { verify: true });

    expect(result.status).toBe('published');
    expect(result.messages).toContain('verified super-mcp-router@2.5.0 on npm');
    expect(npmCommandNames(calls)).toEqual(['view', 'pack', 'publish', 'view', 'view']);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it('verify fails when the version never appears before retry budget is exhausted', async () => {
    const { deps, calls } = makeDeps({
      npmResults: [notFound(), ok(packJson()), ok(''), notFound(), notFound(), notFound()],
    });

    await expect(publishSuperMcp(deps, { verify: true })).rejects.toMatchObject({ code: 'npm-verify-timeout' });
    expect(npmCommandNames(calls)).toEqual(['view', 'pack', 'publish', 'view', 'view', 'view']);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });
});
