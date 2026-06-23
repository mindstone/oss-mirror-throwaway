import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertBundleSmoke } from '../check-oss-build-smoke';

function withBundleRoot(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'oss-build-smoke-'));
  try {
    mkdirSync(path.join(root, 'out', 'main'), { recursive: true });
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFixture(root: string, relativePath: string, contents: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function runBundleSmoke(root: string) {
  return assertBundleSmoke({
    bundleRoots: [path.join(root, 'out', 'main')],
    contractOnly: false,
    usingDefaultBundleRoots: false,
    help: false,
  });
}

describe('check-oss-build-smoke bundle leak scan', () => {
  it('passes clean executable JS and ignores public comment-only sourcemap references', () => {
    withBundleRoot((root) => {
      writeFixture(
        root,
        'out/main/index.js',
        'export const marker = "private-mindstone-stub-stage6";\n',
      );
      writeFixture(
        root,
        'out/main/index.js.map',
        JSON.stringify({
          version: 3,
          sources: ['../../src/shared/utils/contributionRelayFlag.ts'],
          sourcesContent: [
            [
              '// Mentions fetchAuthConfig, submitViaRelay, /api/config, and /api/ping in comments.',
              'export const contributionRelayEnabled = false;',
            ].join('\n'),
          ],
          mappings: '',
        }),
      );

      expect(runBundleSmoke(root)).toBeNull();
    });
  });

  it('fails when executable JS contains the private bundle marker', () => {
    withBundleRoot((root) => {
      writeFixture(
        root,
        'out/main/index.js',
        [
          'export const stub = "private-mindstone-stub-stage6";',
          'export const real = "private-mindstone-real-stage6";',
        ].join('\n'),
      );

      expect(runBundleSmoke(root)).toMatchObject({
        check: 'bundle leak scan',
        message: expect.stringContaining('forbidden Mindstone auth/relay marker'),
        details: [expect.stringContaining('real private marker')],
      });
    });
  });

  it('fails when executable JS contains a private auth provider symbol', () => {
    withBundleRoot((root) => {
      writeFixture(
        root,
        'out/main/index.js',
        [
          'export const stub = "private-mindstone-stub-stage6";',
          'const provider = DESKTOP_REBEL_AUTH_PROVIDER;',
        ].join('\n'),
      );

      expect(runBundleSmoke(root)).toMatchObject({
        check: 'bundle leak scan',
        details: [expect.stringContaining('desktop auth provider symbol')],
      });
    });
  });

  it('fails when a sourcemap ships a private Mindstone source path', () => {
    withBundleRoot((root) => {
      writeFixture(
        root,
        'out/main/index.js',
        'export const marker = "private-mindstone-stub-stage6";\n',
      );
      writeFixture(
        root,
        'out/main/index.js.map',
        JSON.stringify({
          version: 3,
          sources: ['../../private/mindstone/src/services/authService.ts'],
          sourcesContent: ['export const movedPrivateSource = true;'],
          mappings: '',
        }),
      );

      expect(runBundleSmoke(root)).toMatchObject({
        check: 'sourcemap leak scan',
        details: [expect.stringContaining('private sourcemap source path')],
      });
    });
  });

  it('fails when a sourcemap ships a private auth function body', () => {
    withBundleRoot((root) => {
      writeFixture(
        root,
        'out/main/index.js',
        'export const marker = "private-mindstone-stub-stage6";\n',
      );
      writeFixture(
        root,
        'out/main/index.js.map',
        JSON.stringify({
          version: 3,
          sources: ['../../src/main/services/providerSwitch.ts'],
          sourcesContent: [
            [
              'export async function fetchAuthConfig() {',
              '  return fetch("/api/auth/get-session");',
              '}',
            ].join('\n'),
          ],
          mappings: '',
        }),
      );

      expect(runBundleSmoke(root)).toMatchObject({
        check: 'sourcemap leak scan',
        details: [expect.stringContaining('private fetchAuthConfig function body')],
      });
    });
  });
});
