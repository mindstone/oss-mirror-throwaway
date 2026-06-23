/**
 * Tests for scripts/check-atomic-helper-equivalence.ts — the equivalence gate that
 * keeps the OSS-vendored `atomicCredentialWrite.ts` copies byte-equivalent (modulo
 * import line + vendored header) to the host canonical copy.
 *
 * Covers the regression classes this gate exists to kill:
 *   - path rot: a real mcp-servers root present but ZERO copies discovered = FAIL
 *   - silent SKIP only when no root anywhere (and hard FAIL under REQUIRE_…=1)
 *   - resolution-ladder precedence (env override wins; submodule beats sibling)
 *   - bounded-glob discovery of all current copies (connectors/* + packages/*)
 *   - multi-line vendored-header canonicalization (the F4 bug: single-line strip
 *     left the second header line in OSS copies and never matched host)
 *
 * Pure-function tests against on-disk fixtures (temp dirs) — no spawning, no network.
 *
 * @see ../check-atomic-helper-equivalence.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canonicalize,
  discoverCopies,
  evaluate,
  resolveMcpServersRoot,
} from '../check-atomic-helper-equivalence';

// A minimal but realistic host body. The exact contents do not matter for the gate
// logic; what matters is that OSS copies canonicalize identically modulo import +
// header. We keep an `import … from '@core/…'` line so the import-stripping path is
// exercised, and a couple of body lines.
const HOST_BODY = [
  "import fs from 'node:fs';",
  "import { withSingleSyncRetryOnEmfile } from '@core/utils/emfileRetry';",
  '',
  'export async function atomicCredentialWrite(): Promise<void> {',
  '  withSingleSyncRetryOnEmfile(() => fs.constants.O_NOFOLLOW);',
  '}',
  '',
].join('\n');

// OSS body: same as host but with the relative import path. The two-line vendored
// header sits on top — both lines must be stripped by canonicalization.
const OSS_HEADER = [
  '// vendored from upstream commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  '// keep byte-equivalent (modulo import path); see check-atomic-helper-equivalence.ts',
  '',
].join('\n');
const OSS_BODY =
  OSS_HEADER +
  HOST_BODY.replace(
    "import { withSingleSyncRetryOnEmfile } from '@core/utils/emfileRetry';",
    "import { withSingleSyncRetryOnEmfile } from './emfileRetry.js';",
  );

/** Build a fake repo with a host helper at src/core/utils and return its root. */
function makeRepo(root: string, hostBody = HOST_BODY): void {
  const hostDir = join(root, 'src', 'core', 'utils');
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, 'atomicCredentialWrite.ts'), hostBody);
}

/** Write a vendored copy under <mcpRoot>/<group>/<name>/src/utils/. */
function makeCopy(mcpRoot: string, group: 'connectors' | 'packages', name: string, body = OSS_BODY): string {
  const dir = join(mcpRoot, group, name, 'src', 'utils');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'atomicCredentialWrite.ts');
  writeFileSync(p, body);
  return p;
}

/** A directory that passes isMcpServersRoot (has a connectors/ dir). */
function makeMcpRoot(root: string): string {
  mkdirSync(join(root, 'connectors'), { recursive: true });
  return root;
}

describe('canonicalize', () => {
  it('strips the FULL multi-line vendored-header block so OSS copies match host', () => {
    expect(canonicalize(OSS_BODY)).toBe(canonicalize(HOST_BODY));
  });

  it('strips the import line regardless of @core vs relative path', () => {
    const a = canonicalize("import x from '@core/y';\nconst z = 1;\n");
    const b = canonicalize("import x from './y.js';\nconst z = 1;\n");
    expect(a).toBe(b);
  });

  it('does not strip a non-header leading comment', () => {
    const withDoc = canonicalize('// a genuine doc comment\nconst z = 1;\n');
    expect(withDoc).toContain('// a genuine doc comment');
  });
});

describe('resolveMcpServersRoot', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-equiv-ladder-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('honors the MCP_SERVERS_REPO env override above everything', () => {
    const repo = join(tmp, 'repo');
    makeMcpRoot(join(repo, 'mcp-servers')); // submodule present too
    const override = makeMcpRoot(join(tmp, 'elsewhere'));
    const res = resolveMcpServersRoot(repo, { MCP_SERVERS_REPO: override });
    expect(res).toMatchObject({ kind: 'resolved', source: 'env', root: override });
  });

  it('prefers the initialized submodule over the legacy sibling', () => {
    const repo = join(tmp, 'repo');
    makeMcpRoot(join(repo, 'mcp-servers'));
    makeMcpRoot(join(tmp, 'mcp-servers')); // sibling of repo
    const res = resolveMcpServersRoot(repo, {});
    expect(res).toMatchObject({ kind: 'resolved', source: 'submodule' });
  });

  it('treats an uninitialized (empty) submodule dir as absent and falls back to sibling', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(join(repo, 'mcp-servers'), { recursive: true }); // empty: no connectors/
    makeMcpRoot(join(tmp, 'mcp-servers'));
    const res = resolveMcpServersRoot(repo, {});
    expect(res).toMatchObject({ kind: 'resolved', source: 'sibling' });
  });

  it('returns kind:none when no root exists anywhere', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    expect(resolveMcpServersRoot(repo, {})).toEqual({ kind: 'none' });
  });
});

describe('discoverCopies', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-equiv-discover-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finds copies under both connectors/* and packages/*', () => {
    const mcp = makeMcpRoot(join(tmp, 'mcp-servers'));
    const a = makeCopy(mcp, 'connectors', 'hubspot');
    const b = makeCopy(mcp, 'connectors', 'google-workspace');
    const c = makeCopy(mcp, 'packages', 'mcp-server-microsoft-shared');
    expect(discoverCopies(mcp).sort()).toEqual([a, b, c].sort());
  });

  it('returns empty when a real root has no vendored copies', () => {
    const mcp = makeMcpRoot(join(tmp, 'mcp-servers'));
    expect(discoverCopies(mcp)).toEqual([]);
  });
});

describe('evaluate', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-equiv-eval-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // NOTE: evaluate() reads the host helper from <repo>/src/core/utils via the
  // repo arg — the env override points discovery at the fixture mcp-servers root.
  function setup(opts: {
    copies: Array<{ group: 'connectors' | 'packages'; name: string; body?: string }>;
    hostBody?: string;
  }): { repo: string; mcp: string } {
    const repo = join(tmp, 'repo');
    makeRepo(repo, opts.hostBody);
    const mcp = makeMcpRoot(join(tmp, 'mcp-servers-fixture'));
    for (const c of opts.copies) {
      makeCopy(mcp, c.group, c.name, c.body);
    }
    return { repo, mcp };
  }

  it('passes when all three current copies are byte-equivalent to host', () => {
    const { repo, mcp } = setup({
      copies: [
        { group: 'connectors', name: 'hubspot' },
        { group: 'connectors', name: 'google-workspace' },
        { group: 'packages', name: 'mcp-server-microsoft-shared' },
      ],
    });
    const res = evaluate(repo, { MCP_SERVERS_REPO: mcp });
    expect(res.status).toBe('pass');
    if (res.status === 'pass') expect(res.copies).toHaveLength(3);
  });

  it('HARD FAILS when a real root is present but zero copies are discovered (path rot)', () => {
    const { repo, mcp } = setup({ copies: [] });
    const res = evaluate(repo, { MCP_SERVERS_REPO: mcp });
    expect(res.status).toBe('fail');
    if (res.status === 'fail') expect(res.message).toMatch(/path rot/i);
  });

  it('FAILS and lists the mismatched copy when one drifts', () => {
    const { repo, mcp } = setup({
      copies: [
        { group: 'connectors', name: 'hubspot' },
        { group: 'connectors', name: 'drifted', body: OSS_BODY + '\nconst extra = true;\n' },
      ],
    });
    const res = evaluate(repo, { MCP_SERVERS_REPO: mcp });
    expect(res.status).toBe('fail');
    if (res.status === 'fail') expect(res.message).toMatch(/drifted/);
  });

  it('SKIPs (exit 0) when no root anywhere and REQUIRE flag is unset', () => {
    const repo = join(tmp, 'repo');
    makeRepo(repo);
    const res = evaluate(repo, {}); // no env, no submodule, no sibling
    expect(res.status).toBe('skip');
    if (res.status === 'skip') expect(res.message).toMatch(/submodule update --init/);
  });

  it('HARD FAILS when no root anywhere but REQUIRE_MCP_OSS_EQUIVALENCE=1', () => {
    const repo = join(tmp, 'repo');
    makeRepo(repo);
    const res = evaluate(repo, { REQUIRE_MCP_OSS_EQUIVALENCE: '1' });
    expect(res.status).toBe('fail');
  });
});
