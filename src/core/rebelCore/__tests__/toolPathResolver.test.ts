import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  resolveToolPath,
  isAllowedMcpProjectWritePath,
} from '../toolPathResolver';

const CWD = '/Users/tester/Documents/Rebel';
const HOME = '/Users/tester';

// Helper — resolve + assert ok, return resolvedPath.
function expectOk(
  filePath: string,
  opts: { tool: 'Read' | 'Write' | 'Edit'; cwd?: string; homePath?: string },
): string {
  const result = resolveToolPath(filePath, { cwd: CWD, homePath: HOME, ...opts });
  if (!result.ok) {
    throw new Error(`Expected ok but got error: ${result.error} (reason=${result.reason})`);
  }
  return result.resolvedPath;
}

function expectReject(
  filePath: string,
  opts: { tool: 'Read' | 'Write' | 'Edit'; cwd?: string; homePath?: string },
) {
  const result = resolveToolPath(filePath, { cwd: CWD, homePath: HOME, ...opts });
  if (result.ok) {
    throw new Error(`Expected reject but got resolvedPath: ${result.resolvedPath}`);
  }
  return result;
}

describe('resolveToolPath — workspace root zone', () => {
  it('accepts absolute paths inside cwd', () => {
    const resolved = expectOk('/Users/tester/Documents/Rebel/notes/plan.md', { tool: 'Write' });
    expect(resolved).toBe('/Users/tester/Documents/Rebel/notes/plan.md');
  });

  it('accepts relative paths, resolving against cwd', () => {
    const resolved = expectOk('notes/plan.md', { tool: 'Write' });
    expect(resolved).toBe('/Users/tester/Documents/Rebel/notes/plan.md');
  });

  it('accepts the cwd path itself (as a directory marker — filesystem layer will reject if writing to a directory)', () => {
    expectOk('.', { tool: 'Read' });
  });

  it('rejects parent-traversal attempts', () => {
    const r = expectReject('/etc/passwd', { tool: 'Write' });
    expect(r.reason).toBe('outside-allowed-zones');
  });

  it('rejects ../../ traversal relative to cwd', () => {
    const r = expectReject('../../etc/passwd', { tool: 'Write' });
    expect(r.reason).toBe('outside-allowed-zones');
  });
});

describe('resolveToolPath — MCP project zone (all tools)', () => {
  it('accepts Read at ~/mcp-servers/foo-mcp/src/index.ts', () => {
    const resolved = expectOk('~/mcp-servers/foo-mcp/src/index.ts', { tool: 'Read' });
    expect(resolved).toBe('/Users/tester/mcp-servers/foo-mcp/src/index.ts');
  });

  it('accepts Write at ~/mcp-servers/foo-mcp/package.json (project-root allowlist)', () => {
    expectOk('~/mcp-servers/foo-mcp/package.json', { tool: 'Write' });
  });

  it('accepts Edit at ~/mcp-servers/foo-mcp/README.md', () => {
    expectOk('~/mcp-servers/foo-mcp/README.md', { tool: 'Edit' });
  });

  it('accepts Write at the exact tilde-prefixed path the skill mandates', () => {
    expectOk('~/mcp-servers/hello-world-mcp/package.json', { tool: 'Write' });
  });

  it('accepts Write at absolute form (tilde expanded) — identical semantics', () => {
    expectOk('/Users/tester/mcp-servers/hello-world-mcp/package.json', { tool: 'Write' });
  });

  it('accepts subdir writes under src/', () => {
    expectOk('~/mcp-servers/foo-mcp/src/tools/greet.ts', { tool: 'Write' });
  });

  it('accepts subdir writes under docs/', () => {
    expectOk('~/mcp-servers/foo-mcp/docs/build-plan.md', { tool: 'Write' });
  });

  it('accepts subdir writes under tests/ and __tests__/', () => {
    expectOk('~/mcp-servers/foo-mcp/tests/sanity.test.ts', { tool: 'Write' });
    expectOk('~/mcp-servers/foo-mcp/__tests__/unit.test.ts', { tool: 'Write' });
  });

  it('is case-insensitive on the mcp-servers prefix (macOS HFS compat)', () => {
    expectOk('/Users/tester/MCP-Servers/foo-mcp/package.json', { tool: 'Write' });
  });

  it('rejects writes to the mcp-servers root itself', () => {
    const r = expectReject('~/mcp-servers/random.txt', { tool: 'Write' });
    expect(r.reason).toBe('mcp-servers-root-only');
  });

  it('rejects writes to mcp-servers/ directory marker (no project segment)', () => {
    // `~/mcp-servers/` with trailing slash resolves to `~/mcp-servers` which
    // doesn't match the `~/mcp-servers/…` prefix pattern, so it's rejected
    // as outside-allowed-zones rather than mcp-servers-root-only. Either
    // rejection reason is acceptable — the key invariant is the path is not
    // accepted.
    const r = expectReject('~/mcp-servers/', { tool: 'Write' });
    expect(['mcp-servers-root-only', 'outside-allowed-zones']).toContain(r.reason);
  });

  it('rejects Write when homePath is not provided (exception is opt-in)', () => {
    const r = expectReject('/Users/tester/mcp-servers/foo-mcp/package.json', {
      tool: 'Write',
      homePath: undefined,
    });
    expect(r.reason).toBe('outside-allowed-zones');
  });
});

describe('resolveToolPath — Write allowlist (project-root files)', () => {
  const base = '~/mcp-servers/foo-mcp';

  it.each([
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'README.md',
    'LICENSE',
    '.gitignore',
    '.env.example',
    '.nvmrc',
    '.npmrc',
    'CHANGELOG.md',
  ])('accepts Write at project-root file %s', (fileName) => {
    expectOk(`${base}/${fileName}`, { tool: 'Write' });
  });

  it.each([
    '.env',
    '.ssh',
    'id_rsa',
    'random.txt',
    'evil.sh',
    'secrets.json',
  ])('rejects Write at project-root file %s', (fileName) => {
    const r = expectReject(`${base}/${fileName}`, { tool: 'Write' });
    expect(r.reason).toBe('mcp-allowlist-miss');
  });
});

describe('resolveToolPath — Write allowlist (subdirs)', () => {
  const base = '~/mcp-servers/foo-mcp';

  it.each([
    'src/index.ts',
    'src/tools/nested/deep.ts',
    'docs/build-plan.md',
    'tests/sanity.test.ts',
    'test/legacy.test.js',
    '__tests__/suite.test.ts',
    'scripts/setup.sh',
    'examples/demo.json',
    'dist/bundle.js',
    'assets/logo.png',
  ])('accepts Write under allowed subdir: %s', (relPath) => {
    expectOk(`${base}/${relPath}`, { tool: 'Write' });
  });

  it.each([
    'secrets/key.json',
    '.ssh/id_rsa',
    'node_modules/bad.js', // agent shouldn't ever write here — use npm install
    '.git/config',
  ])('rejects Write under disallowed subdir: %s', (relPath) => {
    const r = expectReject(`${base}/${relPath}`, { tool: 'Write' });
    expect(r.reason).toBe('mcp-allowlist-miss');
  });
});

describe('resolveToolPath — Read / Edit skip the allowlist', () => {
  it('Read accepts .env inside an MCP project (to inspect existing files)', () => {
    expectOk('~/mcp-servers/foo-mcp/.env', { tool: 'Read' });
  });

  it('Edit accepts .env inside an MCP project (for in-place tweaks of existing files)', () => {
    expectOk('~/mcp-servers/foo-mcp/.env', { tool: 'Edit' });
  });

  it('Read accepts arbitrary subdir files', () => {
    expectOk('~/mcp-servers/foo-mcp/secrets/config.json', { tool: 'Read' });
  });
});

describe('resolveToolPath — traversal safety', () => {
  it('rejects a tilde-relative path that escapes mcp-servers via ../', () => {
    // Resolves to /Users/tester/Documents/secret.txt — outside both zones.
    const r = expectReject('~/mcp-servers/../Documents/secret.txt', { tool: 'Write' });
    expect(r.reason).toBe('outside-allowed-zones');
  });

  it('rejects symlink-style traversal via absolute path', () => {
    const r = expectReject('/Users/tester/mcp-servers/foo-mcp/../../.ssh/id_rsa', {
      tool: 'Write',
    });
    expect(r.reason).toBe('outside-allowed-zones');
  });

  it('rejects home-dir writes outside mcp-servers', () => {
    const r = expectReject('/Users/tester/.zshrc', { tool: 'Write' });
    expect(r.reason).toBe('outside-allowed-zones');
  });
});

describe('resolveToolPath — behaviour when context inputs are missing', () => {
  it('falls back to process.cwd() when cwd is undefined', () => {
    const processResult = resolveToolPath(
      path.join(process.cwd(), 'foo.txt'),
      { tool: 'Write', homePath: HOME },
    );
    expect(processResult.ok).toBe(true);
  });

  it('disables MCP exception when homePath is undefined (absolute path outside cwd is rejected)', () => {
    // When homePath is missing, the mcp-servers exception is off. An absolute
    // path that's outside `cwd` must be rejected — otherwise the agent could
    // still write to `~/mcp-servers/…` via the absolute form.
    const r = resolveToolPath('/Users/tester/mcp-servers/foo-mcp/package.json', {
      cwd: CWD,
      tool: 'Write',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('outside-allowed-zones');
  });

  it('treats literal "~/" paths as relative-to-cwd when homePath is absent (pre-2026-04-20 behaviour)', () => {
    // Without homePath we don't expand tilde. The string "~/mcp-servers/..." is
    // then resolved as a subdir named "~" under cwd, which is *inside* cwd and
    // thus allowed — matching the pre-fix behaviour where no one passed tilde
    // paths because the tool would reject them anyway. Documented here to pin
    // behaviour so future changes are deliberate.
    const r = resolveToolPath('~/mcp-servers/foo-mcp/package.json', {
      cwd: CWD,
      tool: 'Write',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolvedPath).toBe(path.join(CWD, '~/mcp-servers/foo-mcp/package.json'));
  });
});

describe('resolveToolPath — managed repo (extend-mcp-server skill)', () => {
  const REPO = '~/mcp-servers/mcp-servers-repo';

  it('accepts Write at connectors/<name>/package.json', () => {
    expectOk(`${REPO}/connectors/slack/package.json`, { tool: 'Write' });
  });

  it('accepts Write at connectors/<name>/src/tools/search.ts', () => {
    expectOk(`${REPO}/connectors/slack/src/tools/search.ts`, { tool: 'Write' });
  });

  it('accepts Write at connectors/<name>/test/smoke.test.ts', () => {
    expectOk(`${REPO}/connectors/zendesk/test/smoke.test.ts`, { tool: 'Write' });
  });

  it('accepts Write at connectors/<name>/docs/extension-plan.md (skill working doc)', () => {
    expectOk(`${REPO}/connectors/zendesk/docs/extension-plan.md`, { tool: 'Write' });
  });

  it('accepts Write at connectors/<name>/catalog-entry.json (extend skill metadata)', () => {
    expectOk(`${REPO}/connectors/zendesk/catalog-entry.json`, { tool: 'Write' });
  });

  it('accepts Write at connectors/<name>/.env.example', () => {
    expectOk(`${REPO}/connectors/zendesk/.env.example`, { tool: 'Write' });
  });

  it('accepts Write at connectors/<name>/README.md', () => {
    expectOk(`${REPO}/connectors/slack/README.md`, { tool: 'Write' });
  });

  it('rejects Write at managed-repo root (e.g. README.md at repo root)', () => {
    const r = expectReject(`${REPO}/README.md`, { tool: 'Write' });
    expect(r.reason).toBe('managed-repo-root-only');
  });

  it('rejects Write at managed-repo .github/workflows/ci.yml (outside per-connector scope)', () => {
    const r = expectReject(`${REPO}/.github/workflows/ci.yml`, { tool: 'Write' });
    expect(r.reason).toBe('managed-repo-root-only');
  });

  it('rejects Write directly at connectors/ directory marker', () => {
    const r = expectReject(`${REPO}/connectors/README.md`, { tool: 'Write' });
    expect(r.reason).toBe('managed-repo-root-only');
  });

  it('rejects Write at connectors/<name>/.env (connector-level allowlist still applies)', () => {
    const r = expectReject(`${REPO}/connectors/slack/.env`, { tool: 'Write' });
    expect(r.reason).toBe('mcp-allowlist-miss');
  });

  it('rejects Write at connectors/<name>/node_modules/evil.js', () => {
    const r = expectReject(`${REPO}/connectors/slack/node_modules/evil.js`, {
      tool: 'Write',
    });
    expect(r.reason).toBe('mcp-allowlist-miss');
  });

  it('rejects traversal escaping the managed repo', () => {
    // Resolves to ~/mcp-servers/etc/passwd — treated as a standalone project
    // path with project=etc, where `passwd` fails the Write allowlist.
    // (The key invariant is rejection; exact reason is secondary.)
    const r = expectReject(`${REPO}/connectors/slack/../../../etc/passwd`, {
      tool: 'Write',
    });
    expect(['outside-allowed-zones', 'mcp-allowlist-miss']).toContain(r.reason);
  });

  it('rejects fully escaping ~/mcp-servers/ via deep traversal', () => {
    // 4 levels up lands outside ~/mcp-servers/ entirely.
    const r = expectReject(`${REPO}/connectors/slack/../../../../etc/passwd`, {
      tool: 'Write',
    });
    expect(r.reason).toBe('outside-allowed-zones');
  });

  it('rejects traversal from inside connector escaping to repo root', () => {
    // Resolves to ~/mcp-servers/mcp-servers-repo/README.md — repo root file.
    const r = expectReject(`${REPO}/connectors/slack/../../README.md`, {
      tool: 'Write',
    });
    expect(r.reason).toBe('managed-repo-root-only');
  });

  it('Read allows any file inside connectors/<name>/ (for research phase)', () => {
    // The extend skill's Phase 3 reads connector source/tests; Read skips the allowlist.
    expectOk(`${REPO}/connectors/slack/.env`, { tool: 'Read' });
    expectOk(`${REPO}/connectors/slack/src/client.ts`, { tool: 'Read' });
  });

  it('Read still rejects managed-repo root files (no connector segment)', () => {
    const r = expectReject(`${REPO}/README.md`, { tool: 'Read' });
    expect(r.reason).toBe('managed-repo-root-only');
  });

  it('case-insensitive on the mcp-servers-repo segment', () => {
    expectOk(`~/mcp-servers/MCP-Servers-Repo/connectors/slack/package.json`, {
      tool: 'Write',
    });
  });
});

describe('isAllowedMcpProjectWritePath — pure filename predicate', () => {
  it.each([
    ['package.json', true],
    ['Tsconfig.json', true], // case-insensitive root-file match
    ['tsconfig.build.json', true],
    ['src/index.ts', true],
    ['Docs/plan.md', true], // case-insensitive subdir
    ['.env', false],
    ['secrets/key.json', false],
    ['', false],
  ])('isAllowedMcpProjectWritePath(%s) === %s', (input, expected) => {
    expect(isAllowedMcpProjectWritePath(input)).toBe(expected);
  });
});
